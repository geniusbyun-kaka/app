#!/usr/bin/env node
// 조커픽: "버핏·멍거가 한국 시장에서 고른다면" 주간 자동 스크리닝.
// DART OpenAPI 에서 상장사들의 연간 사업보고서 재무제표 10년치를 받아
//   1) 정량 체크리스트 5개 (ROE 10년 평균 15%+, 부채비율 50% 이하,
//      영업이익률 변동성 5%p 이하, FCF 플러스 9/10년 이상, 순이익 CAGR 7%+)
//   2) 오너 어닝스 2단계 DCF 기본 시나리오에서 안전마진 30% 이상
// 을 통과한 종목 중 안전마진이 가장 큰 1개를 그 주의 조커픽으로 선정한다.
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
async function fetchYear(corp, year) {
  for (const fs of ["CFS", "OFS"]) { // 연결 우선, 없으면 별도
    const j = await dartJson("fnlttSinglAcntAll.json", { corp_code: corp.code, bsns_year: String(year), reprt_code: "11011", fs_div: fs });
    if (j == null) return undefined; // 한도 소진 — 캐시에 기록하지 않는다
    if (j.status === "013" || !j.list?.length) continue;
    if (j.status !== "000") { console.warn(`[joker] ${corp.name} ${year} ${fs}: status ${j.status} ${j.message || ""}`); continue; }
    const y = extractYear(j.list);
    if (y) return y;
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
  const metrics = {
    roe10: (ys.reduce((s, v) => s + v.ni / v.eq, 0) / ys.length) * 100,
    debt: ((last.liab ?? 0) / last.eq) * 100,
    opStd: std(ys.map((v) => (v.op / v.rev) * 100)),
    fcfYears: ys.filter((v) => v.cfo - v.capex > 0).length,
    epsCagr: firstNi > 0 && lastNi > 0 ? ((lastNi / firstNi) ** (1 / (ys.length - 1)) - 1) * 100 : -999,
  };
  const pass = metrics.roe10 >= CHECK.roe10 && metrics.debt <= CHECK.debt && metrics.opStd <= CHECK.opStd
    && metrics.fcfYears >= CHECK.fcfYears && metrics.epsCagr >= CHECK.epsCagr;
  // 오너 어닝스: 순이익 + 감가상각 − min(감가상각, 10년 CAPEX 중앙값)
  const dep = last.dep ?? 0;
  const oe = lastNi + dep - Math.min(dep, median(ys.map((v) => v.capex)) ?? dep);
  const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  return {
    pass,
    metrics: { roe10: round(metrics.roe10), debt: round(metrics.debt), opStd: round(metrics.opStd), fcfYears: metrics.fcfYears, epsCagr: round(metrics.epsCagr) },
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

// ── 현재가: 야후 (KRX 는 .KS 코스피 / .KQ 코스닥) ──
async function fetchPrice(stock) {
  for (const [suffix, market] of [[".KS", "코스피"], [".KQ", "코스닥"]]) {
    try {
      const { rows } = await yahooChart(stock + suffix, { range: "5d", interval: "1d" });
      const c = rows.at(-1)?.c;
      if (c > 0) return { price: c, market };
    } catch {}
  }
  return null;
}

const readJson = async (p, fb) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return fb; } };
const mondayOf = (d) => { const dt = new Date(d); dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); return dt.toISOString().slice(0, 10); };

async function main() {
  await mkdir(path.join(OUT_DIR, "dart"), { recursive: true });
  const universe = await fetchUniverse();
  console.log(`[joker] 유니버스 ${universe.length}개 회사 (금융·스팩·리츠·지주 제외) · 대상 연도 ${YEARS[0]}~${LAST_YEAR}`);

  // 1) 회사별 10년치 재무 수집 (캐시 우선, 이번 실행 한도 안에서 빈 곳만 채운다)
  let complete = 0;
  const screened = [];
  for (const corp of universe) {
    const cachePath = path.join(OUT_DIR, "dart", `${corp.code}.json`);
    const cache = await readJson(cachePath, { code: corp.code, stock: corp.stock, name: corp.name, years: {} });
    let dirty = false;
    for (const y of YEARS) {
      if (cache.years[y] !== undefined || budgetOut) continue;
      const got = await fetchYear(corp, y);
      if (got === undefined) break; // 한도 소진
      cache.years[y] = got;
      dirty = true;
      // 최신 연도가 없으면 (신규 상장 등) 과거 연도는 조회해 봐야 10년을 못 채운다 — 호출 아끼기
      if (y === LAST_YEAR && got === null) { for (const yy of YEARS) if (cache.years[yy] === undefined) { cache.years[yy] = null; } break; }
    }
    if (dirty) await writeFile(cachePath, JSON.stringify(cache));
    if (YEARS.every((y) => cache.years[y] !== undefined)) complete++;
    const s = screenCorp(cache.years);
    if (s?.pass) screened.push({ ...corp, ...s, sharesCached: cache.shares, sharesYear: cache.sharesYear, cachePath, cache });
  }
  const cover = complete / Math.max(universe.length, 1);
  console.log(`[joker] 10년치 수집 완료 ${complete}/${universe.length} (${(cover * 100).toFixed(1)}%) · 이번 실행 DART 호출 ${calls}건 · 체크리스트 통과 ${screened.length}개`);

  // 2) 통과 종목의 주식수·현재가 → 안전마진
  const candidates = [];
  for (const c of screened.slice(0, MAX_PRICE_LOOKUPS)) {
    let shares = c.sharesYear === LAST_YEAR ? c.sharesCached : null;
    if (!shares && !budgetOut) {
      shares = await fetchShares(c, LAST_YEAR);
      if (shares === undefined) shares = null;
      else { c.cache.shares = shares; c.cache.sharesYear = LAST_YEAR; await writeFile(c.cachePath, JSON.stringify(c.cache)); }
    }
    if (!shares) continue;
    const quote = await fetchPrice(c.stock).catch(() => null);
    if (!quote) continue;
    const fair = jokerFair(c.ownerEarnings, c.netCash, shares, BASE);
    const margin = fair != null && fair > 0 ? (fair - quote.price) / fair : null;
    if (margin == null) continue;
    candidates.push({
      name: c.name, ticker: c.stock, market: quote.market, price: Math.round(quote.price), shares,
      netCash: c.netCash, ownerEarnings: c.ownerEarnings, metrics: c.metrics,
      fair: Math.round(fair), margin: Math.round(margin * 1000) / 1000,
      source: `DART ${LAST_YEAR} 사업보고서 (연결)`,
    });
  }
  candidates.sort((a, b) => b.margin - a.margin);
  await writeFile(path.join(OUT_DIR, "candidates.json"), JSON.stringify({ updated: now.toISOString(), lastYear: LAST_YEAR, coverage: cover, candidates }, null, 1));

  // 3) 주간 픽 갱신 (수집률이 낮은 초기에는 픽을 뽑지 않고 진행률만 기록)
  const picksFile = path.join(OUT_DIR, "joker-picks.json");
  const prev = await readJson(picksFile, { picks: [] });
  const picks = (prev.picks || []).filter((p) => p.week !== mondayOf(now)); // 같은 주에 다시 돌리면 교체 (멱등)
  const recentTickers = new Set(picks.slice(0, NO_REPEAT_WEEKS).map((p) => p.ticker));
  const top = candidates.find((c) => c.margin >= MARGIN_MIN && !recentTickers.has(c.ticker));
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
    note: `DART ${LAST_YEAR} 사업보고서 기반 자동 스크리닝 (10년치 수집 완료 ${complete}/${universe.length}개 회사). 유지보수 설비투자는 min(감가상각비, 10년 CAPEX 중앙값) 근사치이며, 금융사·지주사·스팩·리츠는 제외했습니다.`,
    picks: picks.slice(0, 26),
  }, null, 1));
  await writeFile(path.join(OUT_DIR, "meta.json"), JSON.stringify({ updated: now.toISOString(), universe: universe.length, complete, coverage: Math.round(cover * 1000) / 1000, calls, budgetOut, timeOut, minutes: Math.round((Date.now() - T0) / 60000), passed: screened.length, priced: candidates.length }, null, 1));
}

main().catch((err) => { console.error("[joker] 실패:", err); process.exit(1); });
