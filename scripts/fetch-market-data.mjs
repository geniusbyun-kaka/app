#!/usr/bin/env node
// 시세 스냅샷 수집 스크립트 (GitHub Actions에서 10분마다 실행)
//
// 결과물 (기본 출력 폴더: ./data):
//   latest.json    현재가 · 전일 대비 · 일중 고저 (NQ=F, KRW=X)
//   intraday.json  최근 5거래일 5분봉 종가 (NQ=F, KRW=X)
//   history.json   일봉 종가 전체 (NQ=F, ^NDX, QQQ, ^GSPC, KRW=X) — 백테스트용
//
// 데이터 소스: Yahoo Finance chart API (무료, 약 10~15분 지연). 실패 시 Stooq 일봉으로 대체.
// 사용법: node scripts/fetch-market-data.mjs [출력폴더]
//   환경변수 YAHOO_BASE 로 API 호스트를 바꿀 수 있음 (테스트용).

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = process.argv[2] || "data";
const YAHOO_BASE = process.env.YAHOO_BASE || "https://query1.finance.yahoo.com";
const YAHOO_FALLBACK = process.env.YAHOO_BASE ? null : "https://query2.finance.yahoo.com";
const STOOQ_BASE = process.env.STOOQ_BASE || "https://stooq.com";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// 라이브 시세 대상 (현재가 타일 + 일중 차트)
const LIVE = [
  { symbol: "NQ=F", name: "나스닥 100 선물", short: "NQ", kind: "futures" },
  { symbol: "KRW=X", name: "원달러 환율", short: "USD/KRW", kind: "fx" },
];

// 백테스트용 일봉 대상. stooq 는 대체 소스 심볼.
const HISTORY = [
  { symbol: "NQ=F", name: "나스닥 100 선물 (NQ)", stooq: "nq.f", adjust: false },
  { symbol: "^NDX", name: "나스닥 100 지수", stooq: "^ndx", adjust: false },
  { symbol: "QQQ", name: "QQQ ETF (배당 재투자)", stooq: "qqq.us", adjust: true },
  { symbol: "^GSPC", name: "S&P 500 지수", stooq: "^spx", adjust: false },
  { symbol: "KRW=X", name: "원달러 환율", stooq: "usdkrw", adjust: false },
];

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

// Yahoo chart API 한 번 호출. { meta, rows:[{t,o,h,l,c,v,adj}] } 로 정규화.
async function yahooChart(symbol, { range, interval }) {
  const q = `interval=${interval}&range=${range}&includePrePost=false&events=div%2Csplit`;
  const call = async (base) => {
    const url = `${base}/v8/finance/chart/${encodeURIComponent(symbol)}?${q}`;
    const json = await fetchJson(url);
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error(`empty chart result for ${symbol}: ${JSON.stringify(json?.chart?.error)}`);
    return result;
  };
  let result;
  try {
    result = await withRetry(() => call(YAHOO_BASE));
  } catch (err) {
    if (!YAHOO_FALLBACK) throw err;
    result = await withRetry(() => call(YAHOO_FALLBACK));
  }
  const ts = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || [];
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const c = quote.close?.[i];
    if (c == null || !Number.isFinite(c)) continue; // 결측 봉 제거
    rows.push({
      t: ts[i],
      o: quote.open?.[i] ?? null,
      h: quote.high?.[i] ?? null,
      l: quote.low?.[i] ?? null,
      c,
      v: quote.volume?.[i] ?? null,
      adj: adj[i] ?? null,
    });
  }
  return { meta: result.meta || {}, rows };
}

// 거래소 시간대 기준 YYYY-MM-DD
function dateInTz(unixSec, tz) {
  const d = new Date(unixSec * 1000);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// Stooq 일봉 CSV → rows
async function stooqDaily(stooqSymbol) {
  const url = `${STOOQ_BASE}/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`;
  const text = await withRetry(() => fetchText(url));
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2 || !/^Date,Open,High,Low,Close/i.test(lines[0])) {
    throw new Error(`unexpected stooq payload for ${stooqSymbol}: ${lines[0]?.slice(0, 80)}`);
  }
  const dates = [];
  const close = [];
  for (const line of lines.slice(1)) {
    const [d, , , , c] = line.split(",");
    const num = Number(c);
    if (!d || !Number.isFinite(num)) continue;
    dates.push(d);
    close.push(num);
  }
  return { dates, close };
}

function round(n, digits) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

async function buildLive() {
  const latest = { updated: new Date().toISOString(), source: "Yahoo Finance (지연 시세)", quotes: {} };
  const intraday = { updated: latest.updated, series: {} };

  for (const item of LIVE) {
    const digits = item.kind === "fx" ? 2 : 2;
    const [intra, daily] = await Promise.all([
      yahooChart(item.symbol, { range: "5d", interval: "5m" }),
      yahooChart(item.symbol, { range: "1mo", interval: "1d" }),
    ]);
    const meta = intra.meta;
    const tz = meta.exchangeTimezoneName;
    const price = meta.regularMarketPrice ?? intra.rows.at(-1)?.c ?? null;
    const marketTime = meta.regularMarketTime ?? intra.rows.at(-1)?.t ?? null;

    // 전일 종가: meta.previousClose 가 없으면 일봉에서 계산 (오늘 봉이 있으면 그 앞 봉)
    let prevClose = meta.previousClose ?? null;
    if (prevClose == null && daily.rows.length) {
      const today = marketTime ? dateInTz(marketTime, tz) : null;
      const last = daily.rows.at(-1);
      const lastIsToday = today && dateInTz(last.t, tz) === today;
      const prevRow = lastIsToday ? daily.rows.at(-2) : last;
      prevClose = prevRow?.c ?? null;
    }

    // 오늘 세션(거래소 날짜 기준)의 고가·저가
    const sessionDate = marketTime ? dateInTz(marketTime, tz) : null;
    const todayRows = intra.rows.filter((r) => dateInTz(r.t, tz) === sessionDate);
    const dayHigh = meta.regularMarketDayHigh ?? (todayRows.length ? Math.max(...todayRows.map((r) => r.h ?? r.c)) : null);
    const dayLow = meta.regularMarketDayLow ?? (todayRows.length ? Math.min(...todayRows.map((r) => r.l ?? r.c)) : null);

    const change = price != null && prevClose != null ? price - prevClose : null;
    latest.quotes[item.symbol] = {
      symbol: item.symbol,
      name: item.name,
      short: item.short,
      kind: item.kind,
      currency: meta.currency || (item.kind === "fx" ? "KRW" : "USD"),
      price: round(price, digits),
      previousClose: round(prevClose, digits),
      change: round(change, digits),
      changePercent: change != null && prevClose ? round((change / prevClose) * 100, 2) : null,
      dayHigh: round(dayHigh, digits),
      dayLow: round(dayLow, digits),
      fiftyTwoWeekHigh: round(meta.fiftyTwoWeekHigh, digits),
      fiftyTwoWeekLow: round(meta.fiftyTwoWeekLow, digits),
      marketTime: marketTime ? new Date(marketTime * 1000).toISOString() : null,
      marketState: meta.marketState || null,
      exchange: meta.exchangeName || meta.fullExchangeName || null,
      timezone: tz || null,
    };
    intraday.series[item.symbol] = {
      symbol: item.symbol,
      interval: "5m",
      timezone: tz || null,
      previousClose: round(prevClose, digits),
      t: intra.rows.map((r) => r.t),
      c: intra.rows.map((r) => round(r.c, digits)),
    };
    console.log(`[live] ${item.symbol} price=${price} prev=${prevClose} bars=${intra.rows.length}`);
  }
  return { latest, intraday };
}

async function buildHistory() {
  const history = { updated: new Date().toISOString(), symbols: {} };
  for (const item of HISTORY) {
    let dates, close, source;
    try {
      const daily = await yahooChart(item.symbol, { range: "max", interval: "1d" });
      const tz = daily.meta.exchangeTimezoneName;
      const seen = new Set();
      dates = [];
      close = [];
      for (const r of daily.rows) {
        const d = dateInTz(r.t, tz);
        if (seen.has(d)) continue; // 같은 날짜 중복 봉 방지
        const value = item.adjust && r.adj != null ? r.adj : r.c;
        if (!Number.isFinite(value) || value <= 0) continue;
        seen.add(d);
        dates.push(d);
        close.push(round(value, 4));
      }
      source = "yahoo";
    } catch (err) {
      console.warn(`[history] yahoo failed for ${item.symbol}: ${err.message}. trying stooq ${item.stooq}`);
      const alt = await stooqDaily(item.stooq);
      dates = alt.dates;
      close = alt.close;
      source = "stooq";
    }
    if (dates.length < 250) throw new Error(`too little history for ${item.symbol}: ${dates.length} rows`);
    history.symbols[item.symbol] = {
      symbol: item.symbol,
      name: item.name,
      adjusted: !!item.adjust,
      source,
      from: dates[0],
      to: dates.at(-1),
      dates,
      close,
    };
    console.log(`[history] ${item.symbol} ${dates[0]} → ${dates.at(-1)} (${dates.length} rows, ${source})`);
  }
  return history;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const { latest, intraday } = await buildLive();
  await writeFile(path.join(OUT_DIR, "latest.json"), JSON.stringify(latest));
  await writeFile(path.join(OUT_DIR, "intraday.json"), JSON.stringify(intraday));
  const history = await buildHistory();
  await writeFile(path.join(OUT_DIR, "history.json"), JSON.stringify(history));
  console.log(`done → ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
