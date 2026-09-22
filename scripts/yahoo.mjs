// Yahoo Finance chart API 공용 헬퍼. fetch-market-data.mjs 와 fetch-stocks.mjs 가 함께 쓴다.
export const YAHOO_BASE = process.env.YAHOO_BASE || "https://query1.finance.yahoo.com";
export const YAHOO_FALLBACK = process.env.YAHOO_BASE ? null : "https://query2.finance.yahoo.com";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

export async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

export async function withRetry(fn, tries = 3) {
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
// range 대신 period1/period2(유닉스 초)를 주면 그 구간을 명시적으로 요청한다.
// range=max 는 야후가 일봉 요청을 무시하고 월봉 수준으로 내려보내는 경우가 있어 히스토리에는 쓰지 않는다.
export async function yahooChart(symbol, { range, interval, period1, period2 }) {
  const parts = [`interval=${interval}`, "includePrePost=false", "includeAdjustedClose=true", "events=div%2Csplit"];
  if (period1 != null) parts.push(`period1=${Math.floor(period1)}`, `period2=${Math.floor(period2 ?? Date.now() / 1000)}`);
  else parts.push(`range=${range}`);
  const q = parts.join("&");
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
export function dateInTz(unixSec, tz) {
  const d = new Date(unixSec * 1000);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function round(n, digits) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

