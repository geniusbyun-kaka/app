#!/usr/bin/env node
// 버크셔 해서웨이의 13F-HR 보고서를 SEC EDGAR 에서 받아 분기별 보유 종목으로 정리한다.
// GitHub Actions 에서 매주 실행되어 `filings` 브랜치에 올라간다 (13F 는 분기 종료 45일 뒤에 나온다).
//
// 결과물 (출력 폴더 기준):
//   berkshire.json   분기별 보유 종목 (오래된 분기 → 최근 분기), 종목별 CUSIP·이름·티커·주식수·평가액
//   cusips.json      CUSIP → 티커 매핑 캐시 (OpenFIGI). 다음 실행에서 재사용
//
// 사용법: node scripts/fetch-filings.mjs [출력폴더]
//   환경변수 EDGAR_BASE, FIGI_BASE 는 테스트용. EDGAR_USER_AGENT 로 SEC 에 보내는 UA 를 바꿀 수 있다.
//   QUARTERS=24 처럼 주면 최근 N개 분기만 (기본 21 = 5년 + 비교용 1분기).

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = process.argv[2] || "filings-out";
const CIK = "0001067983"; // Berkshire Hathaway Inc
const CIK_NUM = String(Number(CIK));
const EDGAR_DATA = process.env.EDGAR_BASE || "https://data.sec.gov";
const EDGAR_WWW = process.env.EDGAR_BASE || "https://www.sec.gov";
const FIGI_BASE = process.env.FIGI_BASE || "https://api.openfigi.com";
const QUARTERS = Number(process.env.QUARTERS || 21);
// SEC 는 요청자를 식별할 수 있는 User-Agent 를 요구한다
const UA = process.env.EDGAR_USER_AGENT?.trim() || `market-desk/1.0 (${process.env.GITHUB_REPOSITORY || "personal"} via GitHub Actions)`;
if (!process.env.EDGAR_USER_AGENT?.trim()) console.warn("[13f] EDGAR_USER_AGENT 가 비어 있습니다. SEC 는 \"이름 이메일\" 형식의 User-Agent 를 요구하므로 403 이 날 수 있습니다.");

// OpenFIGI 가 막혔을 때를 위한 최소 매핑 (버크셔 대형 보유 종목)
const KNOWN = {
  "037833100": "AAPL", "060505104": "BAC", "025816109": "AXP", "191216100": "KO", "166764100": "CVX", "674599105": "OXY",
  "615369105": "MCO", "500754106": "KHC", "171232101": "CB", "23918K108": "DVA", "501044101": "KR", "92826C839": "V",
  "57636Q104": "MA", "023135106": "AMZN", "172967424": "C", "14040H105": "COF", "92343E102": "VRSN", "25754A201": "DPZ",
  "73278L105": "POOL", "21036P108": "STZ", "G0408V102": "AON", "02005N100": "ALLY", "82968B103": "SIRI", "16119P108": "CHTR",
  "546347105": "LPX", "872590104": "TMUS", "47233W109": "JEF", "526057104": "LEN", "526057302": "LEN-B", "422806109": "HEI-A", "422806208": "HEI",
  "H1467J104": "CB", // Chubb 은 스위스 법인이라 CUSIP 이 H 로 시작하고 OpenFIGI 미국 거래소 조회에 안 잡힌다
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function edgar(url, asText = false) {
  // EDGAR 는 초당 10회 제한. 넉넉히 150ms 간격
  const wait = lastCall + 150 - Date.now(); if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Encoding": "gzip, deflate", Accept: asText ? "*/*" : "application/json" } });
    if (res.ok) return asText ? res.text() : res.json();
    if (res.status === 429 || res.status >= 500) { await sleep(3000 * (i + 1)); continue; }
    if (res.status === 403) throw new Error(`SEC 가 요청을 거부했습니다 (403). SEC 는 자동 조회에 "이름 이메일" 형식의 User-Agent 를 요구합니다. 저장소 Settings → Secrets and variables → Actions 에 EDGAR_USER_AGENT 를 예: "Hong Gildong hong@example.com" 으로 추가하세요. 현재 UA: "${UA}"`);
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  throw new Error(`EDGAR 응답 없음: ${url}`);
}

// 제출 목록에서 13F-HR / 13F-HR/A 만 추린다 (recent 에 부족하면 추가 페이지도 읽음)
async function list13F() {
  const sub = await edgar(`${EDGAR_DATA}/submissions/CIK${CIK}.json`);
  const pages = [sub.filings.recent];
  for (const f of sub.filings.files || []) {
    if (pages.length > 6) break;
    try { pages.push(await edgar(`${EDGAR_DATA}/submissions/${f.name}`)); } catch (err) { console.warn(`[13f] 추가 페이지 실패 ${f.name}: ${err.message}`); }
  }
  const out = [];
  for (const p of pages) {
    for (let i = 0; i < p.accessionNumber.length; i++) {
      const form = p.form[i];
      if (form !== "13F-HR" && form !== "13F-HR/A") continue;
      out.push({ accession: p.accessionNumber[i], form, filed: p.filingDate[i], period: p.reportDate[i], primary: p.primaryDocument[i] });
    }
  }
  out.sort((a, b) => a.period.localeCompare(b.period) || a.filed.localeCompare(b.filed));
  return out;
}

const text = (xml, tag) => { const m = xml.match(new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`)); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : null; };

async function readFiling(f) {
  const folder = `${EDGAR_WWW}/Archives/edgar/data/${CIK_NUM}/${f.accession.replace(/-/g, "")}`;
  const idx = await edgar(`${folder}/index.json`);
  const files = (idx.directory?.item || []).map((x) => x.name);
  const xmls = files.filter((n) => /\.xml$/i.test(n));
  const primaryName = xmls.find((n) => /primary_doc/i.test(n)) || f.primary;
  const tableName = xmls.find((n) => !/primary_doc/i.test(n));
  if (!tableName) throw new Error(`정보표 XML 없음 (${f.accession})`);
  const [primary, table] = await Promise.all([edgar(`${folder}/${primaryName}`, true), edgar(`${folder}/${tableName}`, true)]);
  const amendmentType = text(primary, "amendmentType"); // RESTATEMENT | NEW HOLDINGS | null
  const period = text(primary, "periodOfReport") || f.period;
  const entries = [];
  for (const m of table.matchAll(/<(?:[a-zA-Z0-9]+:)?infoTable[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?infoTable>/g)) {
    const e = m[1];
    const cusip = (text(e, "cusip") || "").toUpperCase();
    const shares = Number(text(e, "sshPrnamt") || 0);
    const type = (text(e, "sshPrnamtType") || "SH").toUpperCase();
    const putCall = text(e, "putCall");
    if (!cusip || type !== "SH" || putCall) continue; // 옵션·채권 제외
    entries.push({ cusip, name: text(e, "nameOfIssuer") || cusip, cls: text(e, "titleOfClass") || "", shares, value: Number(text(e, "value") || 0) });
  }
  return { ...f, period: normalizeDate(period), amendmentType, entries };
}
function normalizeDate(d) {
  if (!d) return d;
  const m = d.match(/(\d{2})-(\d{2})-(\d{4})/); if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return d.slice(0, 10);
}

// 같은 CUSIP(여러 자회사 계정)을 합치고, 값 단위(2023년 이전 천 달러)를 달러로 통일
function aggregate(entries) {
  const byCusip = new Map();
  for (const e of entries) {
    const cur = byCusip.get(e.cusip) || { cusip: e.cusip, name: e.name, cls: e.cls, shares: 0, value: 0 };
    cur.shares += e.shares; cur.value += e.value;
    byCusip.set(e.cusip, cur);
  }
  const holdings = [...byCusip.values()].filter((h) => h.shares > 0);
  const total = holdings.reduce((s, h) => s + h.value, 0);
  const thousands = total > 0 && total < 5e9; // 버크셔 포트폴리오는 1000억 달러 이상 → 이보다 작으면 천 달러 단위
  if (thousands) for (const h of holdings) h.value *= 1000;
  holdings.sort((a, b) => b.value - a.value);
  return { holdings, totalValue: holdings.reduce((s, h) => s + h.value, 0), unitAdjusted: thousands };
}

async function loadCache(name) { try { return JSON.parse(await readFile(path.join(OUT_DIR, name), "utf8")); } catch { return null; } }

// CUSIP → 티커 (OpenFIGI, 키 없이 분당 25회 · 요청당 10건)
async function mapTickers(cusips, cache) {
  const map = { ...(cache || {}) };
  const todo = cusips.filter((c) => !map[c]?.ticker);
  for (let i = 0; i < todo.length; i += 10) {
    const batch = todo.slice(i, i + 10);
    try {
      const res = await fetch(`${FIGI_BASE}/v3/mapping`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch.map((c) => ({ idType: "ID_CUSIP", idValue: c }))) });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      batch.forEach((c, k) => {
        const hits = data[k]?.data || [];
        const pick = hits.find((h) => h.exchCode === "US") || hits[0];
        map[c] = pick?.ticker ? { ticker: pick.ticker.replace(/\//g, "-"), name: pick.name || null } : { ticker: KNOWN[c] || null, name: null };
      });
    } catch (err) {
      console.warn(`[13f] OpenFIGI 실패 (${err.message}) → 내장 매핑으로 대체`);
      batch.forEach((c) => { map[c] = { ticker: KNOWN[c] || null, name: null }; });
    }
    if (i + 10 < todo.length) await sleep(3000);
  }
  return map;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const prev = await loadCache("berkshire.json");
  const prevByAcc = new Map((prev?.filings || []).map((f) => [f.accession, f]));
  const all = await list13F();
  console.log(`[13f] 13F 제출 ${all.length}건`);
  const periods = [...new Set(all.map((f) => f.period))].sort().slice(-QUARTERS);
  const wanted = all.filter((f) => periods.includes(f.period));
  const filings = [];
  for (const f of wanted) {
    const cached = prevByAcc.get(f.accession);
    if (cached) { filings.push(cached); continue; } // 이미 읽은 보고서는 다시 받지 않음
    try {
      const r = await readFiling(f);
      filings.push({ accession: r.accession, form: r.form, filed: r.filed, period: r.period, amendmentType: r.amendmentType, entries: r.entries });
      console.log(`[13f] ${r.form} ${r.period} (${r.filed}) 항목 ${r.entries.length}개${r.amendmentType ? " · " + r.amendmentType : ""}`);
    } catch (err) {
      console.warn(`[13f] ${f.form} ${f.period} 실패: ${err.message}`);
    }
  }
  // 분기별로 원본에 정정 보고서를 적용 (RESTATEMENT 는 교체, NEW HOLDINGS 는 추가)
  const quarters = [];
  for (const period of periods) {
    const group = filings.filter((f) => f.period === period).sort((a, b) => a.filed.localeCompare(b.filed));
    const original = group.find((f) => f.form === "13F-HR");
    if (!original) continue;
    let entries = [...original.entries]; let filed = original.filed; let amended = false;
    for (const a of group.filter((f) => f.form === "13F-HR/A")) {
      amended = true; filed = a.filed;
      if (a.amendmentType === "NEW HOLDINGS") entries = [...entries, ...a.entries];
      else if (a.entries.length) entries = [...a.entries];
    }
    const agg = aggregate(entries);
    quarters.push({ period, filed, accession: original.accession, amended, totalValue: agg.totalValue, count: agg.holdings.length, holdings: agg.holdings });
  }
  const cusips = [...new Set(quarters.flatMap((q) => q.holdings.map((h) => h.cusip)))];
  const tickerMap = await mapTickers(cusips, await loadCache("cusips.json"));
  for (const q of quarters) for (const h of q.holdings) { h.ticker = tickerMap[h.cusip]?.ticker || null; }
  const out = { updated: new Date().toISOString(), cik: CIK, filer: "Berkshire Hathaway Inc", source: "SEC EDGAR 13F-HR · 티커: OpenFIGI", quarters, filings };
  await writeFile(path.join(OUT_DIR, "berkshire.json"), JSON.stringify(out));
  await writeFile(path.join(OUT_DIR, "cusips.json"), JSON.stringify(tickerMap));
  const last = quarters.at(-1);
  console.log(`[13f] 완료: ${quarters.length}분기 (${quarters[0]?.period} ~ ${last?.period}), 최근 분기 ${last?.count}종목, 평가액 $${Math.round(last?.totalValue / 1e9)}B`);
  if (!quarters.length) throw new Error("정리된 분기가 없음");
}

main().catch((err) => { console.error(err); process.exit(1); });
