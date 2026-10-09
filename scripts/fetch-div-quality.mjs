#!/usr/bin/env node
// 배당 퀄리티 자동 계산: 종목 스냅샷(index.json)의 미국 배당주마다 SEC XBRL 에서
// 희석 주당순이익(EPS)을 받아 배당성향(DPS÷EPS)과 이익 커버리지(EPS÷DPS)를 구한다.
// 연속 증가 연수는 fetch-stocks.mjs 가 야후 배당 이력으로 index.json 에 이미 넣는다(div.streakYears).
// 결과물: 출력 폴더의 div-quality.json → 앱의 배당 대시보드가 "자료 준비 중" 대신 점수를 매긴다.
//
// 데이터 출처: SEC EDGAR companyconcept API (무료 공개, 자동 조회 공식 허용 · UA 에 연락처 필요)
//   티커→CIK: https://www.sec.gov/files/company_tickers.json
//   EPS:      https://data.sec.gov/api/xbrl/companyconcept/CIK{10자리}/us-gaap/EarningsPerShareDiluted.json
// 한국 주식·ETF·코인은 대상이 아니다 (ETF 는 배당성향 개념이 없고, 한국 주식 EPS 는 DART 연동 숙제).
//
// 사용법: node scripts/fetch-div-quality.mjs [출력폴더=stocks-out]
//   출력 폴더에 index.json 이 있어야 한다 (fetch-stocks.mjs 실행 뒤 같은 폴더).
//   LIMIT=20 처럼 주면 앞의 N 종목만 (테스트용). SEC_BASE / EDGAR_USER_AGENT 는 테스트·식별용.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = process.argv[2] || "stocks-out";
const SEC_WWW = process.env.SEC_BASE || "https://www.sec.gov";
const SEC_DATA = process.env.SEC_BASE || "https://data.sec.gov";
const LIMIT = Number(process.env.LIMIT || 0);
const UA = process.env.EDGAR_USER_AGENT?.trim() || `market-desk/1.0 (${process.env.GITHUB_REPOSITORY || "personal"} via GitHub Actions)`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function sec(url) {
  const wait = lastCall + 150 - Date.now(); if (wait > 0) await sleep(wait); // SEC 초당 10회 제한에 여유
  lastCall = Date.now();
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    if (res.ok) return res.json();
    if (res.status === 404) return null; // 그 회사에 이 개념의 공시가 없음
    if (res.status === 429 || res.status >= 500) { await sleep(3000 * (i + 1)); continue; }
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  throw new Error(`SEC 응답 없음: ${url}`);
}

// EPS TTM: 분기(약 3개월) 보고치 중 최근 4개의 합. 분기치가 모자라면 최근 연간(약 1년) 보고치.
function epsTtm(concept) {
  const vals = concept?.units?.["USD/shares"] || [];
  const days = (e) => (new Date(e.end) - new Date(e.start)) / 86400000;
  const dedupe = (list) => { // 같은 분기가 10-Q·10-K 에 여러 번 나오면 가장 최근 제출분만
    const m = new Map();
    for (const e of list) { const k = `${e.start}|${e.end}`; if (!m.has(k) || e.filed > m.get(k).filed) m.set(k, e); }
    return [...m.values()].sort((a, b) => a.end.localeCompare(b.end));
  };
  const q = dedupe(vals.filter((e) => e.start && e.end && days(e) > 75 && days(e) < 105 && Number.isFinite(e.val)));
  const last4 = q.slice(-4);
  // 4개 분기가 최근 15개월 안에 모여 있어야 TTM 으로 인정 (중간에 빠진 분기가 있으면 연간치로)
  if (last4.length === 4 && (new Date(last4[3].end) - new Date(last4[0].start)) / 86400000 < 460) {
    return { eps: last4.reduce((s, e) => s + e.val, 0), basis: "4분기 합" };
  }
  const annual = dedupe(vals.filter((e) => e.start && e.end && days(e) > 330 && days(e) < 400 && Number.isFinite(e.val)));
  const a = annual.at(-1);
  if (a && new Date() - new Date(a.end) < 550 * 86400000) return { eps: a.val, basis: `연간 ${a.end.slice(0, 4)}` };
  return null;
}

async function main() {
  const index = JSON.parse(await readFile(path.join(OUT_DIR, "index.json"), "utf8"));
  // 대상: 미국 상장 일반 주식 중 최근 12개월 배당이 있는 종목
  let targets = (index.items || []).filter((x) => x.kind === "stock" && !/\.(KS|KQ)$/.test(x.symbol) && x.div?.ttm > 0);
  if (LIMIT) targets = targets.slice(0, LIMIT);
  console.log(`[divq] 대상 ${targets.length}종목 (미국 배당주)`);

  const tickers = await sec(`${SEC_WWW}/files/company_tickers.json`);
  const cikOf = new Map();
  for (const t of Object.values(tickers || {})) cikOf.set(String(t.ticker).toUpperCase().replace(/\./g, "-"), String(t.cik_str).padStart(10, "0"));

  // 직전 결과 재사용: 이번에 실패한 종목은 지난 값 유지 (SEC 일시 장애에 점수가 사라지지 않게)
  let prev = {}; try { prev = JSON.parse(await readFile(path.join(OUT_DIR, "div-quality.json"), "utf8")).items || {}; } catch {}

  const items = {};
  let ok = 0, noCik = 0, noEps = 0, failed = 0;
  for (const t of targets) {
    const cik = cikOf.get(t.symbol);
    if (!cik) { noCik++; if (prev[t.symbol]) items[t.symbol] = prev[t.symbol]; continue; }
    try {
      let concept = await sec(`${SEC_DATA}/api/xbrl/companyconcept/CIK${cik}/us-gaap/EarningsPerShareDiluted.json`);
      let r = epsTtm(concept);
      if (!r) { concept = await sec(`${SEC_DATA}/api/xbrl/companyconcept/CIK${cik}/us-gaap/EarningsPerShareBasic.json`); r = epsTtm(concept); }
      if (!r) { noEps++; if (prev[t.symbol]) items[t.symbol] = prev[t.symbol]; continue; }
      const dps = t.div.ttm;
      // 적자(EPS ≤ 0)면 배당성향은 정의 불가 → null, 커버리지 0 (점수 로직이 둘 다 0점 처리)
      const payout = r.eps > 0 ? Math.round((dps / r.eps) * 1000) / 10 : null;
      const cover = r.eps > 0 ? Math.round((r.eps / dps) * 100) / 100 : 0;
      items[t.symbol] = { eps: Math.round(r.eps * 100) / 100, basis: r.basis, payout, cover };
      ok++;
    } catch (err) {
      failed++;
      if (prev[t.symbol]) items[t.symbol] = prev[t.symbol];
      console.warn(`[divq] ${t.symbol} 실패: ${err.message}${prev[t.symbol] ? " (지난 값 유지)" : ""}`);
    }
  }
  const out = { updated: new Date().toISOString(), source: "SEC EDGAR XBRL (EPS) · 배당: Yahoo Finance", count: Object.keys(items).length, items };
  await writeFile(path.join(OUT_DIR, "div-quality.json"), JSON.stringify(out));
  console.log(`[divq] 완료: 신규 계산 ${ok}, CIK 없음 ${noCik}, EPS 공시 없음 ${noEps}, 실패 ${failed} → div-quality.json (${Object.keys(items).length}종목)`);
  if (!Object.keys(items).length) throw new Error("계산된 종목이 없음 → 파일을 올리지 않도록 실패 처리");
}

main().catch((err) => { console.error(err); process.exit(1); });
