#!/usr/bin/env node
// 조커픽: "버핏·멍거가 한국 시장에서 고른다면" 주간 자동 스크리닝.
// DART OpenAPI 에서 상장사들의 연간 사업보고서 재무제표 10년치를 받아
//   1) 정량 체크리스트 5개 (ROE 10년 평균 15%+, 부채비율 50% 이하,
//      영업이익률 변동성 5%p 이하, FCF 플러스 9/10년 이상, 순이익 CAGR 7%+)
//   2) 밸류 트랩 필터: 최근 순이익이 직전 3년 고점 대비 15% 넘게 줄었거나(이익 방향 꺾임),
//      ROE 가 최근 3년 연속 하락 중이면 제외 — 10년 평균이 좋아도 방향이 나쁘면 시장은 안 산다
//   3) 지배구조·수급 필터: 최대주주(특수관계인 포함) 지분율 50% 초과, 또는 5일 평균
//      거래대금 5억원 미만이면 제외 — 저평가를 교정해 줄 매수 주체가 없는 품절주 차단
//   4) 오너 어닝스 2단계 DCF 기본 시나리오에서 안전마진 30% 이상
// 을 통과한 종목 중 안전마진이 가장 큰 1개를 그 주의 조커픽 "후보"로 선정한다.
// (후보는 바로 공개되지 않고 invest/joker-approved.json 에 등록되어야 화면에 나온다.)
// 배당 삭감(전년 대비 주당 배당금 감소)은 제외 사유는 아니지만 플래그로 기록해 주간 검토에서 본다.
// GitHub Actions 에서 매주 실행되어 `joker` 브랜치에 올라간다 (invest/index.html 이 읽는다).
//
// 결과물 (출력 폴더 기준):
//   joker-picks.json   프론트가 읽는 주간 픽 (최근 26주)
//   candidates.json    체크리스트 통과 종목 전체와 지표 (디버그·확장용)
//   meta.json          수집 진행률 (유니버스 대비 10년치 완비 비율 등)
//   dart/{corp}.json   회사별 연간 재무 캐시. 과거 연도는 다시 받지 않는다
//
// 사용법: DART_API_KEY=... node scripts/fetch-joker-picks.mjs [출력폴더]
//   DART_API_KEY   opendart.fss.or.kr 에서 무료 발급 (하루 20,000 건 한도)
//   MAX_CALLS      이번 실행의 DART 호출 상한 (기본 15000). 캐시가 차면 호출이 급감한다
//   MIN_COVER      픽을 뽑기 위한 최소 수집률 (기본 0.7). 그 전에는 진행률만 기록
//   DART_BASE, YAHOO_BASE 는 테스트용 오버라이드
//
// 산식 주의사항 (프론트 invest/index.html 의 조커픽 화면과 동일해야 한다):
//   오너 어닝스 = 지배주주 순이익 + 감가상각·상각비 − 유지보수 설비투자
//   유지보수 설비투자 = min(감가상각비, 10년 CAPEX 중앙값) 로 근사 (버핏도 판단의 영역이라고 한 부분)
//   순현금 = 현금및현금성자산 + 단기금융상품 − 차입금·사채
//   ROE 는 연말 지배주주지분 기준, 순이익 CAGR 은 주식수 변동을 무시한 근사치
//   금융사(은행·증권·보험 등)와 스팩·리츠·지주사는 이 산식이 맞지 않아 이름 기준으로 제외

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { yahooChart, withRetry } from "./yahoo.mjs";

const OUT_DIR = process.argv[2] || "joker-out";
const KEY = process.env.DART_API_KEY?.trim();
const DART_BASE = process.env.DART_BASE || "https://opendart.fss.or.kr";
const MAX_CALLS = Number(process.env.MAX_CALLS || 15000);
const MIN_COVER = Number(process.env.MIN_COVER || 0.7);
// 실행 시간 예산: DART 가 느린 시간대에는 15,000건이 워크플로 타임아웃(300분) 안에 못 끝나
// 잡이 통째로 취소되고 그 실행의 캐시가 유실된다. 시간이 다 되면 수집을 멈추고
// 그때까지 모은 캐시를 발행하도록, 타임아웃보다 넉넉히 짧은 예산을 둔다.
const TIME_BUDGET_MIN = Number(process.env.TIME_BUDGET_MIN || 240);
// DART 응답이 느린 날에도 처리량을 지키기 위한 동시 요청 수 (공식 한도인 분당 1,000건보다 한참 낮다)
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
// 수집이 한도를 정확히 소진하면 통과 종목의 주식수·주가 조회가 굶는다 (5차 실행에서 실제 발생).
// 그 몫을 남겨두기 위해 수집 단계는 이 상한까지만 호출한다.
const COLLECT_CAP = MAX_CALLS - Math.min(400, Math.ceil(MAX_CALLS * 0.2));
const T0 = Date.now();
if (!KEY) {
  console.error("[joker] DART_API_KEY 가 없습니다. opendart.fss.or.kr 에서 발급받아 리포 시크릿 DART_API_KEY 로 넣어주세요.");
  process.exit(1);
}

// 대상 회계연도: 사업보고서는 3월 말까지 제출되므로 5월 전에는 전전년도까지만 요구한다
const now = new Date();
const LAST_YEAR = now.getUTCFullYear() - (now.getUTCMonth() + 1 >= 5 ? 1 : 2);
const YEARS = Array.from({ length: 10 }, (_, i) => LAST_YEAR - 9 + i);

// 프론트(JK_SCN)와 같은 기본 시나리오: 성장 8% · 할인 10% · 영구 2%
const BASE = { g: 0.08, r: 0.1, tg: 0.02 };
const CHECK = { roe10: 15, debt: 50, opStd: 5, fcfYears: 9, epsCagr: 7 };
const MARGIN_MIN = 0.3; // 안전마진 30% 이상만 픽 후보
const NI_DECLINE_MAX = -15; // 최근 순이익이 직전 3년 고점 대비 이보다 더 줄었으면 제외 (%)
const MAJOR_MAX = 50; // 최대주주(특수관계인 포함) 지분율 상한 (%)
const MIN_TRADE_EOK = 5; // 5일 평균 거래대금 하한 (억원)
const NO_REPEAT_WEEKS = 12; // 최근 12주 안에 뽑힌 종목은 다시 뽑지 않는다
const MAX_PRICE_LOOKUPS = 120; // 주가·주식수 조회 상한 (통과 종목이 비정상적으로 많을 때 안전장치)

// 금융업·스팩·리츠·지주사는 산식이 맞지 않아 이름으로 거른다 (보수적: 애매하면 제외)
const EXCLUDE_NAME = /스팩|기업인수목적|리츠|위탁관리부동산|은행|증권|보험|카드|캐피탈|금융|생명|화재|해상|손해|저축|자산운용|투자자문|창업투자|벤처투자|인베스트|홀딩스|지주/;

let calls = 0, budgetOut = false, timeOut = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function dart(pathname, params = {}) {
  if (!timeOut && Date.now() - T0 > TIME_BUDGET_MIN * 60000) {
    timeOut = true;
    console.warn(`[joker] 시간 예산 ${TIME_BUDGET_MIN}분 도달 — 남은 조회는 다음 실행으로 미루고 지금까지의 캐시를 저장합니다`);
  }
  if (budgetOut || timeOut || calls >= MAX_CALLS) { budgetOut = true; return null; }
  calls++;
  const q = new URLSearchParams({ crtfc_key: KEY, ...params });
  const url = `${DART_BASE}/api/${pathname}?${q}`;
  let res;
  try {
    res = await withRetry(async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} for ${pathname}`);
      return r;
    });
  } catch (err) {
    // 재시도까지 전부 실패하는 지속적 네트워크 오류 (예: DART 쪽 ECONNRESET).
    // 여기서 예외가 새 나가면 실행 전체가 죽고 이번 실행의 캐시가 유실되므로,
    // 한도 소진과 똑같이 수집을 멈추고 지금까지 모은 캐시를 저장하러 간다.
    const code = err?.cause?.code || err?.code || err?.message || err;
    console.warn(`[joker] DART 네트워크 오류가 계속됩니다 (${code}) — 남은 조회는 다음 실행으로 미루고 지금까지의 캐시를 저장합니다`);
    budgetOut = true;
    return null;
  }
  await sleep(50);
  return res;
}
async function dartJson(pathname, params) {
  const res = await dart(pathname, params);
  if (!res) return null;
  let j;
  try { j = await res.json(); } catch { return null; } // 본문이 끊긴 응답은 이 호출만 건너뛴다 (캐시에 기록 안 함)
  if (j.status === "020" || j.status === "021") { console.warn(`[joker] DART 사용 한도 도달 (status ${j.status}) — 남은 조회는 다음 실행으로 미룹니다`); budgetOut = true; return null; }
  return j;
}

// ── ZIP 안의 첫 XML 꺼내기 (corpCode.xml 은 ZIP 하나에 CORPCODE.xml 하나) ──
function unzipEntry(buf, nameRe) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("ZIP EOCD not found");
  const count = buf.readUInt16LE(e + 10);
  let off = buf.readUInt32LE(e + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (nameRe.test(name)) {
      const lnl = buf.readUInt16LE(lho + 26), lel = buf.readUInt16LE(lho + 28);
      const data = buf.subarray(lho + 30 + lnl + lel, lho + 30 + lnl + lel + csize);
      return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  throw new Error(`ZIP entry ${nameRe} not found`);
}

// ── 상장사 목록: corpCode.xml (stock_code 가 있는 회사만) ──
async function fetchUniverse() {
  const res = await dart("corpCode.xml");
  if (!res) throw new Error("corpCode.xml 을 받지 못했습니다");
  const xml = unzipEntry(Buffer.from(await res.arrayBuffer()), /corpcode\.xml/i).toString("utf8");
  const tag = (s, t) => (s.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1]?.trim() || "";
  const out = [];
  for (const m of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const s = m[1];
    const stock = tag(s, "stock_code");
    if (!/^\d{6}$/.test(stock)) continue;
    const name = tag(s, "corp_name");
    if (EXCLUDE_NAME.test(name)) continue;
    out.push({ code: tag(s, "corp_code"), stock, name });
  }
  return out;
}

// ── 연간 재무제표 한 해치 → 필요한 숫자만 추출 ──
const num = (s) => { const v = Number(String(s ?? "").replace(/,/g, "")); return Number.isFinite(v) ? v : null; };
function extractYear(list) {
  const isIS = (it) => it.sj_div === "IS" || it.sj_div === "CIS"; // 포괄손익계산서만 내는 회사도 있다
  const first = (pred) => { for (const it of list) if (pred(it)) { const v = num(it.thstrm_amount); if (v != null) return v; } return null; };
  const sumAbs = (pred) => { let s = null; for (const it of list) if (pred(it)) { const v = num(it.thstrm_amount); if (v != null) s = (s ?? 0) + Math.abs(v); } return s; };
  const byId = (ids, sj) => (it) => ids.includes(it.account_id) && (!sj || sj(it));
  const byNm = (re, sj, ex) => (it) => sj(it) && re.test(it.account_nm || "") && !(ex && ex.test(it.account_nm || ""));
  const BS = (it) => it.sj_div === "BS", CF = (it) => it.sj_div === "CF";
  const rev = first(byId(["ifrs-full_Revenue", "ifrs_Revenue"], isIS)) ?? first(byNm(/^매출액$|^수익\(매출액\)$|^매출$/, isIS));
  const op = first(byId(["dart_OperatingIncomeLoss"], isIS)) ?? first(byNm(/^영업이익(\(손실\))?$/, isIS));
  const ni = first(byId(["ifrs-full_ProfitLossAttributableToOwnersOfParent"], isIS))
    ?? first(byNm(/지배기업.*(순이익|지분)|지배주주.*순이익/, isIS))
    ?? first(byId(["ifrs-full_ProfitLoss", "ifrs_ProfitLoss"], isIS))
    ?? first(byNm(/^당기순이익(\(손실\))?$/, isIS));
  const eq = first(byId(["ifrs-full_EquityAttributableToOwnersOfParent", "ifrs_EquityAttributableToOwnersOfParent"], BS))
    ?? first(byId(["ifrs-full_Equity", "ifrs_Equity"], BS)) ?? first(byNm(/^자본총계$/, BS));
  const liab = first(byId(["ifrs-full_Liabilities", "ifrs_Liabilities"], BS)) ?? first(byNm(/^부채총계$/, BS));
  const cfo = first(byId(["ifrs-full_CashFlowsFromUsedInOperatingActivities", "ifrs_CashFlowsFromUsedInOperatingActivities"], CF))
    ?? first(byNm(/영업활동.*현금흐름/, CF));
  const capex = sumAbs(byNm(/유형자산의?\s*취득|무형자산의?\s*취득/, CF));
  const dep = sumAbs(byNm(/감가상각|상각비/, CF, /대손|손상|미상각/));
  const cash = (first(byId(["ifrs-full_CashAndCashEquivalents", "ifrs_CashAndCashEquivalents"], BS)) ?? first(byNm(/^현금및현금성자산/, BS)) ?? 0)
    + (sumAbs(byNm(/단기금융상품/, BS)) ?? 0);
  const borrow = sumAbs(byNm(/차입금|^사채$|사채\(/, BS)) ?? 0;
  if (ni == null || eq == null) return null; // 최소한 순이익·자본이 없으면 못 쓴다
  return { rev, op, ni, eq, liab, cfo, capex, dep, cash, borrow };
}
// prefer 가 "OFS" 면 별도재무제표부터 조회한다 (연결이 없는 회사로 확인된 경우 호출 절약).
// 반환: undefined = 한도 소진, null = 데이터 없음, { data, fs } = 성공(어느 재무제표였는지 포함)
async function fetchYear(corp, year, prefer) {
  const order = prefer === "OFS" ? ["OFS", "CFS"] : ["CFS", "OFS"];
  for (const fs of order) {
    const j = await dartJson("fnlttSinglAcntAll.json", { corp_code: corp.code, bsns_year: String(year), reprt_code: "11011", fs_div: fs });
    if (j == null) return undefined; // 한도 소진 — 캐시에 기록하지 않는다
    if (j.status === "013" || !j.list?.length) continue;
    if (j.status !== "000") { console.warn(`[joker] ${corp.name} ${year} ${fs}: status ${j.status} ${j.message || ""}`); continue; }
    const y = extractYear(j.list);
    if (y) return { data: y, fs };
  }
  return null; // 조회했지만 데이터 없음 (다시 받지 않는다)
}

// ── 발행주식수 (자사주 제외 유통주식수, 보통주) ──
async function fetchShares(corp, year) {
  const j = await dartJson("stockTotqySttus.json", { corp_code: corp.code, bsns_year: String(year), reprt_code: "11011" });
  if (j == null) return undefined;
  if (j.status !== "000" || !j.list?.length) return null;
  const row = j.list.find((x) => /보통주/.test(x.se || "")) || j.list.find((x) => /합계/.test(x.se || ""));
  if (!row) return null;
  const distb = num(row.distb_stock_co);
  if (distb > 0) return distb;
  const issued = num(row.now_to_isu_stock_totqy) ?? num(row.istc_totqy);
  return issued > 0 ? issued - (num(row.tesstk_co) || 0) : null;
}

// ── 체크리스트 + DCF (프론트와 동일 산식) ──
const std = (a) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : null; };
function screenCorp(years) {
  const ys = YEARS.map((y) => years[y]);
  if (ys.some((v) => !v)) return null; // 10년치가 다 있어야 판정
  if (ys.some((v) => !(v.eq > 0) || !(v.rev > 0) || v.op == null || v.cfo == null || v.capex == null)) return null;
  const last = ys[ys.length - 1], firstNi = ys[0].ni, lastNi = last.ni;
  const roeSeries = ys.map((v) => (v.ni / v.eq) * 100);
  // 밸류 트랩 필터: 10년 평균이 좋아도 최근 방향이 꺾였으면 시장은 평균을 안 쳐준다
  const peak3 = Math.max(ys[ys.length - 4].ni, ys[ys.length - 3].ni, ys[ys.length - 2].ni); // 직전 3년(최근 연도 제외) 순이익 고점
  const niTrend = peak3 > 0 ? (lastNi / peak3 - 1) * 100 : null; // 최근 순이익의 고점 대비 %
  const roe3 = roeSeries.slice(-3);
  const roeDown = roe3[0] > roe3[1] && roe3[1] > roe3[2]; // ROE 3년 연속 하락
  const metrics = {
    roe10: (ys.reduce((s, v) => s + v.ni / v.eq, 0) / ys.length) * 100,
    debt: ((last.liab ?? 0) / last.eq) * 100,
    opStd: std(ys.map((v) => (v.op / v.rev) * 100)),
    fcfYears: ys.filter((v) => v.cfo - v.capex > 0).length,
    epsCagr: firstNi > 0 && lastNi > 0 ? ((lastNi / firstNi) ** (1 / (ys.length - 1)) - 1) * 100 : -999,
  };
  const pass = metrics.roe10 >= CHECK.roe10 && metrics.debt <= CHECK.debt && metrics.opStd <= CHECK.opStd
    && metrics.fcfYears >= CHECK.fcfYears && metrics.epsCagr >= CHECK.epsCagr
    && (niTrend == null || niTrend >= NI_DECLINE_MAX) && !roeDown;
  // 오너 어닝스: 순이익 + 감가상각 − min(감가상각, 10년 CAPEX 중앙값)
  const dep = last.dep ?? 0;
  const oe = lastNi + dep - Math.min(dep, median(ys.map((v) => v.capex)) ?? dep);
  const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  return {
    pass,
    metrics: { roe10: round(metrics.roe10), debt: round(metrics.debt), opStd: round(metrics.opStd), fcfYears: metrics.fcfYears, epsCagr: round(metrics.epsCagr),
      niTrend: round(niTrend), roeDown, roe3: roe3.map((v) => round(v)) },
    ownerEarnings: Math.round(oe / 1e8), // 억원
    netCash: Math.round(((last.cash ?? 0) - (last.borrow ?? 0)) / 1e8), // 억원
  };
}
function jokerFair(oeEok, netCashEok, shares, { g, r, tg }) {
  const oe = oeEok * 1e8;
  if (!(shares > 0) || !(oe > 0) || r - tg < 0.005) return null;
  let pv1 = 0;
  for (let t = 1; t <= 10; t++) pv1 += (oe * (1 + g) ** t) / (1 + r) ** t;
  const pv2 = (oe * (1 + g) ** 10 * (1 + tg)) / (r - tg) / (1 + r) ** 10;
  return (pv1 + pv2 + netCashEok * 1e8) / shares;
}

// ── 현재가 + 5일 평균 거래대금: 야후 (KRX 는 .KS 코스피 / .KQ 코스닥) ──
async function fetchPrice(stock) {
  for (const [suffix, market] of [[".KS", "코스피"], [".KQ", "코스닥"]]) {
    try {
      const { rows } = await yahooChart(stock + suffix, { range: "5d", interval: "1d" });
      const c = rows.at(-1)?.c;
      if (c > 0) {
        const vals = rows.map((r) => (r.c || 0) * (r.v || 0)).filter((v) => v > 0);
        const avgValueEok = vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length / 1e8) * 10) / 10 : null;
        return { price: c, market, avgValueEok };
      }
    } catch {}
  }
  return null;
}

// ── 최대주주(특수관계인 포함) 기말 지분율 % — 없거나 못 읽으면 null (제외하지 않고 검토에서 본다) ──
async function fetchMajorHolder(corp, year) {
  const j = await dartJson("hyslrSttus.json", { corp_code: corp.code, bsns_year: String(year), reprt_code: "11011" });
  if (j == null) return undefined; // 한도 소진
  if (j.status !== "000" || !j.list?.length) return null;
  const total = j.list.find((x) => /^계$|합\s*계/.test(String(x.nm || "").trim()));
  let rt = num(total?.trmend_posesn_stock_qota_rt) ?? num(total?.bsis_posesn_stock_qota_rt);
  if (rt == null) { // 합계 행이 없으면 행별 기말 지분율 합
    for (const x of j.list) { const v = num(x.trmend_posesn_stock_qota_rt); if (v != null) rt = (rt ?? 0) + v; }
  }
  return rt != null && rt > 0 && rt <= 100 ? Math.round(rt * 10) / 10 : null;
}

// ── 주당 현금배당금(보통주) 당기·전기 → 배당 삭감 플래그. 못 읽으면 null ──
async function fetchDividendCut(corp, year) {
  const j = await dartJson("alotMatter.json", { corp_code: corp.code, bsns_year: String(year), reprt_code: "11011" });
  if (j == null) return undefined; // 한도 소진
  if (j.status !== "000" || !j.list?.length) return null;
  const row = j.list.find((x) => /주당\s*현금배당금/.test(x.se || "") && (!x.stock_knd || /보통/.test(x.stock_knd)));
  if (!row) return null;
  const cur = num(row.thstrm), prev = num(row.frmtrm);
  if (cur == null || prev == null) return null;
  return prev > 0 && cur < prev;
}

const readJson = async (p, fb) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return fb; } };
const mondayOf = (d) => { const dt = new Date(d); dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); return dt.toISOString().slice(0, 10); };

async function main() {
  await mkdir(path.join(OUT_DIR, "dart"), { recursive: true });
  const universe = await fetchUniverse();
  console.log(`[joker] 유니버스 ${universe.length}개 회사 (금융·스팩·리츠·지주 제외) · 대상 연도 ${YEARS[0]}~${LAST_YEAR}`);

  // 회사별 캐시를 한 번에 읽어둔다 (조회는 아직 안 함)
  const entries = [];
  for (const corp of universe) {
    const cachePath = path.join(OUT_DIR, "dart", `${corp.code}.json`);
    entries.push({ corp, cachePath, cache: await readJson(cachePath, { code: corp.code, stock: corp.stock, name: corp.name, years: {} }) });
  }

  // 통과 종목의 주식수·현재가 → 후보 등록. 이미 등록한 티커는 건너뛴다.
  // 수집 전과 후에 각각 부르므로, 수집이 어떤 이유(한도·시간·네트워크)로 끝나도
  // 기존 캐시로 통과한 종목의 픽 후보는 항상 확보되어 있다 (5차 실행에서 굶었던 문제의 근본 해결).
  const candidates = new Map();
  const rejected = new Set(); // 지배구조·수급 필터로 떨어진 종목 (다음 루프에서 다시 조회하지 않게)
  const priceCandidates = async () => {
    for (const e of entries) {
      if (candidates.has(e.corp.stock) || rejected.has(e.corp.stock) || candidates.size >= MAX_PRICE_LOOKUPS) continue;
      const s = screenCorp(e.cache.years);
      if (!s?.pass) continue;
      let shares = e.cache.sharesYear === LAST_YEAR ? e.cache.shares : null;
      if (!shares && !budgetOut) {
        shares = await fetchShares(e.corp, LAST_YEAR);
        if (shares === undefined) shares = null;
        else { e.cache.shares = shares; e.cache.sharesYear = LAST_YEAR; await writeFile(e.cachePath, JSON.stringify(e.cache)); }
      }
      if (!shares) continue;
      const quote = await fetchPrice(e.corp.stock).catch(() => null);
      if (!quote) continue;
      // 수급 필터: 거래대금이 너무 작으면 저평가를 교정해 줄 매수 주체가 없다 (품절주의 저주)
      if (quote.avgValueEok != null && quote.avgValueEok < MIN_TRADE_EOK) {
        rejected.add(e.corp.stock);
        console.log(`[joker] ${e.corp.name} 제외 — 5일 평균 거래대금 ${quote.avgValueEok}억원 < ${MIN_TRADE_EOK}억원`);
        continue;
      }
      // 지배구조 필터: 대주주 지분이 절반을 넘으면 유통주식이 적고, 현금이 소액주주에게 환류될 신뢰도 낮다
      let mh = e.cache.mhYear === LAST_YEAR ? e.cache.mh : undefined;
      if (mh === undefined && !budgetOut) {
        mh = await fetchMajorHolder(e.corp, LAST_YEAR);
        if (mh !== undefined) { e.cache.mh = mh; e.cache.mhYear = LAST_YEAR; await writeFile(e.cachePath, JSON.stringify(e.cache)); }
      }
      if (mh != null && mh > MAJOR_MAX) {
        rejected.add(e.corp.stock);
        console.log(`[joker] ${e.corp.name} 제외 — 최대주주 지분율 ${mh}% > ${MAJOR_MAX}%`);
        continue;
      }
      // 배당 삭감은 제외 사유가 아니라 플래그: 주간 검토에서 매도 신호로 참고한다
      let divCut = e.cache.divCutYear === LAST_YEAR ? e.cache.divCut : undefined;
      if (divCut === undefined && !budgetOut) {
        divCut = await fetchDividendCut(e.corp, LAST_YEAR);
        if (divCut !== undefined) { e.cache.divCut = divCut; e.cache.divCutYear = LAST_YEAR; await writeFile(e.cachePath, JSON.stringify(e.cache)); }
      }
      const fair = jokerFair(s.ownerEarnings, s.netCash, shares, BASE);
      const margin = fair != null && fair > 0 ? (fair - quote.price) / fair : null;
      if (margin == null) continue;
      candidates.set(e.corp.stock, {
        name: e.corp.name, ticker: e.corp.stock, market: quote.market, price: Math.round(quote.price), shares,
        netCash: s.netCash, ownerEarnings: s.ownerEarnings,
        metrics: { ...s.metrics, majorHolder: mh ?? null, avgValueEok: quote.avgValueEok ?? null, divCut: divCut ?? null },
        fair: Math.round(fair), margin: Math.round(margin * 1000) / 1000,
        source: `DART ${LAST_YEAR} 사업보고서 (연결)`,
      });
    }
  };

  // 1) 수집 전에 먼저, 지금 캐시로 통과한 종목의 가격부터 확보한다
  await priceCandidates();
  if (candidates.size) console.log(`[joker] 기존 캐시 기준 픽 후보 ${candidates.size}개 가격 확보`);

  // 2) 회사별 10년치 재무 수집 (이번 실행 한도 안에서 빈 곳만 채운다).
  // DART 가 요청당 응답을 느리게 줄 때가 있어(한 건에 수 초) 워커 여러 개로 동시에 받는다.
  const processCorp = async (e) => {
    let dirty = false;
    // 최신 연도부터 조회: 최신이 없으면(신규 상장 등) 과거 조회를 건너뛰고,
    // 연결재무제표가 없는 회사로 확인되면 다음 연도부터 별도를 먼저 조회해 호출을 아낀다
    for (const y of [...YEARS].reverse()) {
      if (e.cache.years[y] !== undefined || budgetOut || calls >= COLLECT_CAP) continue;
      const got = await fetchYear(e.corp, y, e.cache.fs);
      if (got === undefined) break; // 한도 소진
      e.cache.years[y] = got ? got.data : null;
      if (got && got.fs === "OFS" && e.cache.fs !== "OFS") e.cache.fs = "OFS";
      dirty = true;
      if (y === LAST_YEAR && got === null) { for (const yy of YEARS) if (e.cache.years[yy] === undefined) { e.cache.years[yy] = null; } break; }
    }
    if (dirty) await writeFile(e.cachePath, JSON.stringify(e.cache));
  };
  let ci = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (ci < entries.length && !budgetOut && calls < COLLECT_CAP) await processCorp(entries[ci++]);
  }));

  // 3) 수집으로 새로 통과한 종목도 남은 한도 안에서 가격을 확보한다
  await priceCandidates();

  let complete = 0, passed = 0;
  for (const e of entries) {
    if (YEARS.every((y) => e.cache.years[y] !== undefined)) complete++;
    if (screenCorp(e.cache.years)?.pass) passed++;
  }
  const cover = complete / Math.max(universe.length, 1);
  console.log(`[joker] 10년치 수집 완료 ${complete}/${universe.length} (${(cover * 100).toFixed(1)}%) · 이번 실행 DART 호출 ${calls}건 · 체크리스트 통과 ${passed}개`);

  const candList = [...candidates.values()].sort((a, b) => b.margin - a.margin);
  await writeFile(path.join(OUT_DIR, "candidates.json"), JSON.stringify({ updated: now.toISOString(), lastYear: LAST_YEAR, coverage: cover, candidates: candList }, null, 1));

  // 3) 주간 픽 갱신 (수집률이 낮은 초기에는 픽을 뽑지 않고 진행률만 기록)
  const picksFile = path.join(OUT_DIR, "joker-picks.json");
  const prev = await readJson(picksFile, { picks: [] });
  const picks = (prev.picks || []).filter((p) => p.week !== mondayOf(now)); // 같은 주에 다시 돌리면 교체 (멱등)
  const recentTickers = new Set(picks.slice(0, NO_REPEAT_WEEKS).map((p) => p.ticker));
  const top = candList.find((c) => c.margin >= MARGIN_MIN && !recentTickers.has(c.ticker));
  if (cover >= MIN_COVER && top) {
    const { fair, margin, ...pick } = top;
    picks.unshift({ week: mondayOf(now), ...pick });
    console.log(`[joker] 이번 주 조커픽: ${top.name} (${top.ticker}) 적정주가 ${fair.toLocaleString()}원 · 안전마진 ${(margin * 100).toFixed(1)}%`);
  } else {
    console.log(cover < MIN_COVER
      ? `[joker] 수집률 ${(cover * 100).toFixed(1)}% < ${MIN_COVER * 100}% — 픽은 다음 실행부터 (워크플로를 수동으로 몇 번 더 돌리면 캐시가 채워집니다)`
      : `[joker] 안전마진 ${MARGIN_MIN * 100}% 이상인 신규 종목이 이번 주에는 없습니다`);
  }
  await writeFile(picksFile, JSON.stringify({
    updated: now.toISOString().slice(0, 10),
    note: `DART ${LAST_YEAR} 사업보고서 기반 자동 스크리닝 (10년치 수집 완료 ${complete}/${universe.length}개 회사). 유지보수 설비투자는 min(감가상각비, 10년 CAPEX 중앙값) 근사치이며, 금융사·지주사·스팩·리츠는 제외했습니다. 이익 방향(직전 3년 고점 대비)·ROE 추세·최대주주 지분율·거래대금 필터를 통과한 후보만 올라옵니다.`,
    picks: picks.slice(0, 26),
  }, null, 1));
  await writeFile(path.join(OUT_DIR, "meta.json"), JSON.stringify({ updated: now.toISOString(), universe: universe.length, complete, coverage: Math.round(cover * 1000) / 1000, calls, budgetOut, timeOut, minutes: Math.round((Date.now() - T0) / 60000), passed, priced: candList.length }, null, 1));
}

main().catch((err) => { console.error("[joker] 실패:", err); process.exit(1); });
