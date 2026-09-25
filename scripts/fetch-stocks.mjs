#!/usr/bin/env node
// S&P 500 전 종목 + 주요 ETF + 투자 대가(13F) 보유 종목의 일봉 전체와 최근 5일 5분봉을 받아
// 종목별 JSON 으로 저장한다. GitHub Actions 에서 하루 한 번(미국 장 마감 후) 실행되어 `stocks` 브랜치에 올라간다.
//
// 결과물 (출력 폴더 기준):
//   index.json          종목 목록 + 현재가 요약 (앱의 검색·목록용, 작음)
//   stocks/<심볼>.json  종목별 상세 (시세 요약, 일봉 전체, 5분봉)
//
// 사용법: node scripts/fetch-stocks.mjs [출력폴더]
//   출력 폴더에 직전 실행 결과가 있으면 실패한 종목은 그 파일을 그대로 둔다.
//   환경변수 WIKI_BASE(구성종목 표 소스), YAHOO_BASE, FILINGS_BASE(13F 스냅샷 소스)는 테스트용.
//   LIMIT=20 처럼 주면 앞의 N 종목만 받는다 (테스트용).

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fetchJson, fetchText, yahooChart, dateInTz, round } from "./yahoo.mjs";

const OUT_DIR = process.argv[2] || "stocks-out";
const WIKI_URL = `${process.env.WIKI_BASE || "https://en.wikipedia.org"}/wiki/List_of_S%26P_500_companies`;
const LIMIT = Number(process.env.LIMIT || 0);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
// 투자 대가 13F 스냅샷 (filings 브랜치). 대가 보유 종목도 차트·현재가를 쓸 수 있게 스냅샷에 포함시킨다.
const FILINGS_BASE = process.env.FILINGS_BASE || `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY || "geniusbyun-kaka/app"}/filings`;
const GURU_FILES = ["berkshire.json", "pershing.json", "baupost.json", "thirdpoint.json", "greenlight.json", "himalaya.json"];

// 비교 도구에서 자주 쓰는 ETF. S&P 500 구성종목 목록에 없는 것들.
const ETFS = [
  ["SPY", "SPDR S&P 500 ETF"], ["VOO", "Vanguard S&P 500 ETF"], ["QQQ", "Invesco QQQ (나스닥 100)"], ["TQQQ", "ProShares UltraPro QQQ (나스닥 100 3배)"],
  ["SQQQ", "ProShares UltraPro Short QQQ (나스닥 100 -3배)"], ["QLD", "ProShares Ultra QQQ (나스닥 100 2배)"], ["SPXL", "Direxion S&P 500 Bull 3X"], ["UPRO", "ProShares UltraPro S&P 500 (3배)"],
  ["SSO", "ProShares Ultra S&P 500 (2배)"], ["SOXX", "iShares Semiconductor ETF"], ["SOXL", "Direxion Semiconductor Bull 3X"], ["SMH", "VanEck Semiconductor ETF"],
  ["VTI", "Vanguard Total Stock Market ETF"], ["IWM", "iShares Russell 2000 ETF"], ["DIA", "SPDR Dow Jones ETF"], ["XLK", "Technology Select Sector SPDR"],
  ["SCHD", "Schwab US Dividend Equity ETF"], ["JEPI", "JPMorgan Equity Premium Income ETF"], ["JEPQ", "JPMorgan Nasdaq Equity Premium Income ETF"], ["ARKK", "ARK Innovation ETF"],
  ["TLT", "iShares 20+ Year Treasury Bond ETF"], ["IEF", "iShares 7-10 Year Treasury Bond ETF"], ["BND", "Vanguard Total Bond Market ETF"], ["GLD", "SPDR Gold Shares"],
  ["SLV", "iShares Silver Trust"], ["USO", "United States Oil Fund"], ["VNQ", "Vanguard Real Estate ETF"], ["VEA", "Vanguard FTSE Developed Markets ETF"],
  ["VWO", "Vanguard FTSE Emerging Markets ETF"], ["EWY", "iShares MSCI South Korea ETF"], ["IBIT", "iShares Bitcoin Trust"], ["BITO", "ProShares Bitcoin Strategy ETF"],
  // 배당·분배 ETF
  ["VYM", "Vanguard High Dividend Yield ETF"], ["VIG", "Vanguard Dividend Appreciation ETF"], ["DGRO", "iShares Core Dividend Growth ETF"], ["HDV", "iShares Core High Dividend ETF"],
  ["SPYD", "SPDR S&P 500 High Dividend ETF"], ["DVY", "iShares Select Dividend ETF"], ["SDY", "SPDR S&P Dividend ETF"], ["NOBL", "ProShares S&P 500 Dividend Aristocrats"],
  ["DIVO", "Amplify CWP Enhanced Dividend Income"], ["QYLD", "Global X Nasdaq 100 Covered Call (월배당)"], ["XYLD", "Global X S&P 500 Covered Call (월배당)"], ["RYLD", "Global X Russell 2000 Covered Call (월배당)"],
  ["SPHD", "Invesco S&P 500 High Div Low Vol (월배당)"], ["TLTW", "iShares 20+ Treasury BuyWrite (월배당)"], ["MAIN", "Main Street Capital (월배당 BDC)"], ["ARCC", "Ares Capital (BDC)"],
];

// 국내 배당주 (유가증권시장 .KS). 이름은 야후 메타로 갱신된다.
const KR_DIV = [
  ["005930.KS", "삼성전자"], ["005380.KS", "현대차"], ["000270.KS", "기아"], ["105560.KS", "KB금융"], ["055550.KS", "신한지주"],
  ["086790.KS", "하나금융지주"], ["316140.KS", "우리금융지주"], ["138040.KS", "메리츠금융지주"], ["005490.KS", "POSCO홀딩스"],
  ["017670.KS", "SK텔레콤"], ["030200.KS", "KT"], ["033780.KS", "KT&G"], ["010950.KS", "S-Oil"], ["088980.KS", "맥쿼리인프라"],
  ["024110.KS", "기업은행"], ["029780.KS", "삼성카드"], ["000810.KS", "삼성화재"], ["032640.KS", "LG유플러스"], ["003550.KS", "LG"], ["034730.KS", "SK"],
];
// 코인 (야후 심볼 -USD). 배당이 없어 배당 탭에는 안 나오고 코인 탭 검색·차트용.
const COINS = [
  ["BTC-USD", "비트코인"], ["ETH-USD", "이더리움"], ["USDT-USD", "테더"], ["XRP-USD", "리플"], ["BNB-USD", "바이낸스코인"],
  ["SOL-USD", "솔라나"], ["USDC-USD", "USD코인"], ["DOGE-USD", "도지코인"], ["ADA-USD", "카르다노 (에이다)"], ["TRX-USD", "트론"],
  ["AVAX-USD", "아발란체"], ["LINK-USD", "체인링크"], ["DOT-USD", "폴카닷"], ["LTC-USD", "라이트코인"], ["BCH-USD", "비트코인캐시"],
  ["XLM-USD", "스텔라루멘"], ["SHIB-USD", "시바이누"], ["NEAR-USD", "니어프로토콜"], ["ATOM-USD", "코스모스"], ["HBAR-USD", "헤데라"],
];

// 국내 상장 리츠
const KR_REIT = [
  ["395400.KS", "SK리츠"], ["330590.KS", "롯데리츠"], ["348950.KS", "제이알글로벌리츠"], ["293940.KS", "신한알파리츠"],
  ["088260.KS", "이리츠코크렙"], ["365550.KS", "ESR켄달스퀘어리츠"], ["357120.KS", "코람코라이프인프라리츠"],
];
// 국내 커버드콜·월배당 ETF
const KR_CC = [
  ["458730.KS", "TIGER 미국배당다우존스"], ["458760.KS", "TIGER 미국배당다우존스타겟커버드콜2호"],
  ["441680.KS", "TIGER 미국나스닥100커버드콜(합성)"], ["289480.KS", "TIGER 200커버드콜"],
  ["161510.KS", "PLUS 고배당주"], ["279530.KS", "KODEX 고배당"],
];

const decode = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// 위키백과 "List of S&P 500 companies" 의 constituents 표에서 심볼·회사명·섹터를 읽는다.
async function fetchConstituents() {
  const html = await fetchText(WIKI_URL);
  const start = html.indexOf('id="constituents"');
  if (start < 0) throw new Error("constituents table not found");
  const end = html.indexOf("</table>", start);
  const table = html.slice(start, end);
  const rows = [];
  for (const tr of table.split(/<tr[\s>]/).slice(1)) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => decode(m[1]));
    if (cells.length < 3) continue;
    const symbol = cells[0].replace(/\./g, "-"); // BRK.B → BRK-B (Yahoo 표기)
    if (!/^[A-Z][A-Z0-9-]{0,6}$/.test(symbol)) continue;
    rows.push({ symbol, name: cells[1], sector: cells[2], kind: "stock" });
  }
  if (rows.length < 480 || rows.length > 520) throw new Error(`unexpected constituent count ${rows.length}`);
  return rows;
}

// 투자 대가 13F 에서 최근 8개 분기에 등장한 티커를 모은다 (채권·해외 코드 등 야후에 없는 표기는 제외)
async function fetchGuruTickers() {
  const tickers = new Map(); // symbol → 13F 상 이름 (야후 이름을 받으면 그걸로 교체)
  for (const file of GURU_FILES) {
    try {
      const f = await fetchJson(`${FILINGS_BASE}/${file}`);
      for (const q of (f.quarters || []).slice(-8))
        for (const h of q.holdings || []) {
          const t = (h.ticker || "").trim();
          if (!/^[A-Z][A-Z0-9.-]{0,6}$/.test(t)) continue;
          // 워런트(-WS, ~WW)·유럽 거래소 코드(~EUR)·끝이 숫자인 코드 등 야후 미국 시세가 없는 표기 제외
          if (/\d$/.test(t) || /-WS$/.test(t) || /WW$/.test(t) || /[A-Z](EUR|GBP|CHF)$/.test(t)) continue;
          if (!tickers.has(t)) tickers.set(t, h.name || t);
        }
    } catch (err) {
      console.warn(`[stocks] 13F ${file} 불러오기 실패 (${err.message}) → 이 filer 는 건너뜀`);
    }
  }
  return tickers;
}

async function previousIndex() {
  try {
    return JSON.parse(await readFile(path.join(OUT_DIR, "index.json"), "utf8"));
  } catch {
    return null;
  }
}

// 429 등 일시 오류에 길게 물러나며 재시도
async function retry(fn, label) {
  const waits = [2000, 6000, 15000, 30000];
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= waits.length) throw err;
      const w = /429|Too Many/.test(err.message) ? waits[i] * 2 : waits[i];
      console.warn(`[stocks] ${label}: ${err.message} → ${w / 1000}s 후 재시도`);
      await new Promise((r) => setTimeout(r, w));
    }
  }
}

// 배당 이력 요약: 지급 주기, 최근 12개월 합계, 최근 1회 금액, 다음 배당락 예상일 (과거 간격으로 추정)
function summarizeDividends(divs, tz, price) {
  const items = divs.map((d) => ({ d: dateInTz(d.t, tz), a: round(d.amount, 4) })).filter((x) => x.a > 0);
  if (!items.length) return null;
  const last = items.at(-1);
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1);
  const ttmItems = items.filter((x) => x.d > cutoff.toISOString().slice(0, 10) && x.d <= today);
  const ttm = round(ttmItems.reduce((s, x) => s + x.a, 0), 4);
  // 최근 2년 배당락 간격의 중앙값으로 주기 판단
  const recent = items.slice(-9);
  const gaps = []; for (let i = 1; i < recent.length; i++) gaps.push((new Date(recent[i].d) - new Date(recent[i - 1].d)) / 86400000);
  gaps.sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const freq = gap == null ? "irregular" : gap <= 40 ? "monthly" : gap <= 110 ? "quarterly" : gap <= 220 ? "semiannual" : gap <= 400 ? "annual" : "irregular";
  const perYear = { monthly: 12, quarterly: 4, semiannual: 2, annual: 1, irregular: ttmItems.length || 1 }[freq];
  // 정기 배당 금액: 최근 3회의 중앙값. 한 번짜리 특별배당은 걸러지고, 배당 인상은 두 번째 지급부터 반영된다
  const amts = items.slice(-3).map((x) => x.a).sort((a, b) => a - b);
  const regular = amts.length ? amts[Math.floor(amts.length / 2)] : last.a;
  let nextEx = null;
  if (gap != null && freq !== "irregular") {
    const d = new Date(last.d); d.setDate(d.getDate() + Math.round(gap));
    while (d.toISOString().slice(0, 10) < today) d.setDate(d.getDate() + Math.round(gap)); // 이미 지난 예상일은 다음 주기로
    if (d.getUTCDay() === 6) d.setDate(d.getDate() + 2); if (d.getUTCDay() === 0) d.setDate(d.getDate() + 1);
    nextEx = d.toISOString().slice(0, 10);
  }
  return {
    lastEx: last.d, lastAmount: last.a, freq, perYear, regular: round(regular, 4), ttm, count12: ttmItems.length,
    yieldTtm: price ? round(ttm / price, 5) : null, yieldFwd: price ? round((regular * perYear) / price, 5) : null,
    nextEx, gapDays: gap == null ? null : Math.round(gap),
  };
}

function packDaily(rows, tz) {
  // 날짜는 첫 날짜 + 일 단위 간격 배열로 압축 (앱에서 다시 펼친다)
  const seen = new Set();
  const dates = [], close = [], tr = [];
  for (const r of rows) {
    const d = dateInTz(r.t, tz);
    if (seen.has(d) || !Number.isFinite(r.c) || r.c <= 0) continue;
    seen.add(d);
    dates.push(d);
    close.push(round(r.c, r.c >= 100 ? 2 : 4));
    tr.push(round(Number.isFinite(r.adj) && r.adj > 0 ? r.adj : r.c, 4));
  }
  const gaps = [];
  for (let i = 1; i < dates.length; i++) gaps.push(Math.round((new Date(dates[i]) - new Date(dates[i - 1])) / 86400000));
  return { d0: dates[0], gaps, close, tr, rows: dates.length, from: dates[0], to: dates.at(-1) };
}

async function fetchOne(item) {
  const [daily, intra] = await Promise.all([
    retry(() => yahooChart(item.symbol, { interval: "1d", period1: 0 }), `${item.symbol} 일봉`),
    retry(() => yahooChart(item.symbol, { range: "5d", interval: "5m" }), `${item.symbol} 5분봉`),
  ]);
  const tz = daily.meta.exchangeTimezoneName || "America/New_York";
  if (daily.meta.dataGranularity && daily.meta.dataGranularity !== "1d") throw new Error(`granularity ${daily.meta.dataGranularity}`);
  const packed = packDaily(daily.rows, tz);
  if (packed.rows < 30) throw new Error(`only ${packed.rows} daily rows`);
  const meta = intra.meta;
  const price = meta.regularMarketPrice ?? intra.rows.at(-1)?.c ?? packed.close.at(-1);
  const marketTime = meta.regularMarketTime ?? intra.rows.at(-1)?.t ?? null;
  // 전일 종가: meta 에 없으면 일봉에서 (마지막 봉이 오늘이면 그 앞 봉)
  let prev = meta.previousClose ?? null;
  if (prev == null) {
    const today = marketTime ? dateInTz(marketTime, tz) : null;
    const lastIsToday = today && packed.to === today;
    prev = lastIsToday ? packed.close.at(-2) : packed.close.at(-1);
  }
  const change = price != null && prev != null ? price - prev : null;
  const d = price >= 100 ? 2 : 4;
  // 국내 종목은 목록의 한글 이름을 쓰고, 야후 이름은 코드 검증용으로 로그에만 남긴다
  const metaName = meta.shortName || meta.longName || daily.meta.shortName || daily.meta.longName;
  if (/\.(KS|KQ)$/.test(item.symbol) && metaName) console.log(`[stocks] ${item.symbol} = ${item.name} (야후: ${metaName})`);
  return {
    symbol: item.symbol, name: item.preferYahooName && metaName ? metaName : item.name, sector: item.sector, kind: item.kind,
    currency: meta.currency || "USD", timezone: tz, updated: new Date().toISOString(),
    quote: {
      price: round(price, d), previousClose: round(prev, d), change: round(change, d),
      changePercent: change != null && prev ? round((change / prev) * 100, 2) : null,
      open: round(daily.rows.at(-1)?.o, d), dayHigh: round(meta.regularMarketDayHigh ?? daily.rows.at(-1)?.h, d), dayLow: round(meta.regularMarketDayLow ?? daily.rows.at(-1)?.l, d),
      volume: meta.regularMarketVolume ?? daily.rows.at(-1)?.v ?? null,
      fiftyTwoWeekHigh: round(meta.fiftyTwoWeekHigh, d), fiftyTwoWeekLow: round(meta.fiftyTwoWeekLow, d),
      marketTime: marketTime ? new Date(marketTime * 1000).toISOString() : null, marketState: meta.marketState || null,
    },
    daily: { d0: packed.d0, gaps: packed.gaps, close: packed.close, tr: packed.tr, from: packed.from, to: packed.to },
    // 배당 이력 (최근 6년, 배당락일 기준 주당 금액)과 요약
    dividends: daily.dividends.filter((d) => d.t > Date.now() / 1000 - 6 * 365.25 * 86400).map((d) => [dateInTz(d.t, tz), round(d.amount, 4)]),
    div: summarizeDividends(daily.dividends, tz, price),
    intraday: { previousClose: round(prev, d), t: intra.rows.map((r) => r.t), c: intra.rows.map((r) => round(r.c, d)) },
  };
}

async function main() {
  await mkdir(path.join(OUT_DIR, "stocks"), { recursive: true });
  const prevIndex = await previousIndex();
  let stocks;
  try {
    stocks = await fetchConstituents();
    console.log(`[stocks] 위키백과 구성종목 ${stocks.length}개`);
  } catch (err) {
    const prev = prevIndex?.items?.filter((x) => x.kind === "stock");
    if (!prev?.length) throw new Error(`구성종목 목록을 받지 못했고 직전 목록도 없음: ${err.message}`);
    console.warn(`[stocks] 위키백과 실패 (${err.message}) → 직전 목록 ${prev.length}개 재사용`);
    stocks = prev.map((x) => ({ symbol: x.symbol, name: x.name, sector: x.sector, kind: "stock" }));
  }
  const etfs = ETFS.map(([symbol, name]) => ({ symbol, name, sector: "ETF", kind: "etf" }));
  const stockSet = new Set(stocks.map((s) => s.symbol));
  const extraEtfs = etfs.filter((e) => !stockSet.has(e.symbol));
  // LIMIT 은 테스트용: 주식만 앞에서 N 개로 줄이고 ETF 는 항상 포함
  const krItems = [
    ...KR_DIV.map(([symbol, name]) => ({ symbol, name, sector: "국내 배당주", kind: "stock" })),
    ...KR_REIT.map(([symbol, name]) => ({ symbol, name, sector: "국내 리츠", kind: "stock" })),
    ...KR_CC.map(([symbol, name]) => ({ symbol, name, sector: "국내 커버드콜", kind: "etf" })),
  ];
  const coinItems = COINS.map(([symbol, name]) => ({ symbol, name, sector: "코인", kind: "coin" }));
  const baseItems = [...(LIMIT ? stocks.slice(0, LIMIT) : stocks), ...extraEtfs, ...krItems, ...coinItems];
  // 투자 대가 보유 종목 중 아직 목록에 없는 티커 추가 (이름은 야후 메타로 교체)
  const known = new Set([...stocks.map((s) => s.symbol), ...baseItems.map((x) => x.symbol)]);
  const guruTickers = await fetchGuruTickers();
  const guruItems = [...guruTickers]
    .filter(([symbol]) => !known.has(symbol))
    .map(([symbol, name]) => ({ symbol, name, sector: "대가 보유", kind: "stock", preferYahooName: true }));
  console.log(`[stocks] 투자 대가 보유 종목 추가: ${guruItems.length}개${guruItems.length ? ` (${guruItems.slice(0, 12).map((x) => x.symbol).join(", ")}${guruItems.length > 12 ? " …" : ""})` : ""}`);
  const items = [...baseItems, ...guruItems];

  const prevItems = new Map((prevIndex?.items || []).map((x) => [x.symbol, x]));
  const results = [];
  const failed = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        const data = await fetchOne(item);
        await writeFile(path.join(OUT_DIR, "stocks", `${item.symbol}.json`), JSON.stringify(data));
        results.push({ symbol: item.symbol, name: data.name, sector: item.sector, kind: item.kind, currency: data.currency, price: data.quote.price, changePercent: data.quote.changePercent, from: data.daily.from, to: data.daily.to, updated: data.updated, div: data.div });
      } catch (err) {
        const prev = prevItems.get(item.symbol);
        failed.push(item.symbol);
        console.warn(`[stocks] ${item.symbol} 실패: ${err.message}${prev ? " (직전 파일 유지)" : ""}`);
        if (prev) results.push({ ...prev, stale: true });
      }
      await new Promise((r) => setTimeout(r, 150)); // 야후에 부담 주지 않도록 간격
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  results.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const index = { updated: new Date().toISOString(), source: "Yahoo Finance (지연 시세) · 구성종목: Wikipedia", count: results.length, failed, items: results };
  await writeFile(path.join(OUT_DIR, "index.json"), JSON.stringify(index));
  console.log(`[stocks] 완료: ${results.length}개 저장, 실패 ${failed.length}개${failed.length ? ` (${failed.slice(0, 20).join(", ")}${failed.length > 20 ? " …" : ""})` : ""}`);
  if (results.length < items.length * 0.5) throw new Error("절반 이상 실패 → 스냅샷을 올리지 않음");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
