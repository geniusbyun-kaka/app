#!/usr/bin/env node
// 마이 페이지의 '뉴스 및 공시'용 종목별 뉴스 스냅샷.
// 대가들의 13F 보유 종목(filings 브랜치) + 인기 종목/ETF 목록을 모아
// Yahoo Finance 검색 API 에서 종목당 최신 기사 2개씩 받아 제목을 한국어로 번역해 저장한다.
// 기존 CNBC 뉴스 워크플로(news-data.yml)에서 매일 한국시간 오전 6시(21:00 UTC)에 함께 실행된다.
//
// 결과물 (출력 폴더 기준):
//   stock-news.json  { updated, count, items: { TICKER: [{ title, titleKo, url, publisher, published }] } }
//
// 사용법: node scripts/fetch-stock-news.mjs [출력폴더]
//   STOCKNEWS_PER=2    종목당 기사 수 (기본 2)
//   STOCKNEWS_MAX=250  최대 종목 수 (기본 250)

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = process.argv[2] || "news-out";
const REPO = process.env.GITHUB_REPOSITORY || "geniusbyun-kaka/app";
const PER = Number(process.env.STOCKNEWS_PER || 2);
const MAX = Number(process.env.STOCKNEWS_MAX || 250);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 대가 13F 파일 (filings 브랜치). 없으면 조용히 건너뛴다.
const FILINGS_FILES = ["berkshire.json", "pershing.json", "baupost.json", "thirdpoint.json", "greenlight.json", "himalaya.json", "patient.json", "firsteagle.json"];
// 즐겨찾기에 자주 오를 만한 인기 종목·ETF (13F 밖 보완용)
const POPULAR = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "GOOG", "AMZN", "META", "TSLA", "BRK-B", "AVGO",
  "LLY", "JPM", "V", "MA", "XOM", "UNH", "WMT", "COST", "NFLX", "AMD",
  "KO", "PEP", "PG", "JNJ", "HD", "PLTR", "ORCL", "CRM", "INTC", "DIS",
  "QQQ", "SPY", "VOO", "TQQQ", "SCHD", "JEPI", "O", "TLT", "IVV", "DIA",
];

async function fetchJson(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (res.ok) return res.json();
      if (res.status === 429 || res.status >= 500) { await sleep(1500 * (i + 1)); continue; }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) { if (i === 2) throw err; await sleep(1500 * (i + 1)); }
  }
  throw new Error(`응답 없음: ${url}`);
}

// 대가들의 최신 분기 보유 종목 티커를 모은다 (실패해도 인기 목록만으로 진행)
async function guruTickers() {
  const out = new Set();
  for (const file of FILINGS_FILES) {
    try {
      const f = await fetchJson(`https://raw.githubusercontent.com/${REPO}/filings/${file}`);
      const latest = f?.quarters?.at?.(-1);
      for (const h of latest?.holdings || []) if (h.ticker && /^[A-Z0-9.-]{1,10}$/.test(h.ticker)) out.add(h.ticker);
      console.log(`[stock-news] ${file}: 보유 종목 ${latest?.holdings?.length ?? 0}개`);
    } catch (err) { console.warn(`[stock-news] ${file} 건너뜀: ${err.message}`); }
  }
  return out;
}

// fetch-news.mjs 와 같은 무료 번역 엔드포인트. 짧은 제목만 번역하므로 가볍게 2회만 시도.
async function toKorean(text) {
  if (!text?.trim()) return null;
  const q = encodeURIComponent(text);
  const endpoints = [
    { u: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=${q}`, pick: (j) => (j?.[0] || []).map((seg) => seg?.[0] || "").join("") },
    { u: `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=ko&q=${q}`, pick: (j) => (Array.isArray(j) ? (Array.isArray(j[0]) ? j[0][0] : j[0]) : "") },
  ];
  for (const e of endpoints) {
    try {
      await sleep(200);
      const res = await fetch(e.u, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const out = String(e.pick(await res.json()) || "").trim();
      if (out && out.toLowerCase() !== text.trim().toLowerCase()) return out;
    } catch {}
  }
  return null;
}

// Yahoo Finance 검색 API 에서 종목 관련 최신 기사. 관련 티커에 해당 종목이 있는 기사를 우선한다.
async function tickerNews(sym) {
  const bases = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
  let j = null, lastErr = null;
  for (const b of bases) {
    try { j = await fetchJson(`${b}/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=0&newsCount=8&enableFuzzyQuery=false`); break; }
    catch (err) { lastErr = err; }
  }
  if (!j) throw lastErr || new Error("검색 실패");
  const news = (j.news || []).filter((n) => n?.title && n?.link);
  const related = news.filter((n) => (n.relatedTickers || []).includes(sym));
  const picked = (related.length ? related : news)
    .sort((a, b) => (b.providerPublishTime || 0) - (a.providerPublishTime || 0))
    .slice(0, PER);
  return picked.map((n) => ({
    title: n.title,
    titleKo: null,
    url: n.link,
    publisher: n.publisher || null,
    published: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
  }));
}

async function main() {
  const tickers = await guruTickers();
  for (const t of POPULAR) tickers.add(t);
  const list = [...tickers].slice(0, MAX);
  console.log(`[stock-news] 대상 종목 ${list.length}개`);
  const items = {};
  let ok = 0, fail = 0;
  for (const sym of list) {
    try {
      const news = await tickerNews(sym);
      if (news.length) { items[sym] = news; ok++; }
      await sleep(150);
    } catch (err) { fail++; console.warn(`[stock-news] ${sym} 실패: ${err.message}`); }
  }
  console.log(`[stock-news] 기사 수집: ${ok}종목 성공 · ${fail}종목 실패. 제목 번역 중…`);
  for (const sym of Object.keys(items)) {
    for (const n of items[sym]) n.titleKo = await toKorean(n.title);
  }
  const out = { updated: new Date().toISOString(), source: "Yahoo Finance", count: Object.keys(items).length, perTicker: PER, items };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "stock-news.json"), JSON.stringify(out));
  console.log(`[stock-news] ${path.join(OUT_DIR, "stock-news.json")} 저장 (${out.count}종목)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
