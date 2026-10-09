#!/usr/bin/env node
// 강력 추천 매일 푸시 알림: 미국 장 마감 뒤 종가 기준으로 "레전드 픽 매수 가격 따라가기"의
// 따라 사기 판단을 다시 계산해, 강력 추천(현재가 < 레전드 최근 매수가)이 있으면
// Supabase push_subscriptions 에 등록된 모든 기기로 웹 푸시를 보낸다.
//
// 판정 로직은 앱(invest/index.html)의 공용 로직을 그대로 포팅했다:
//   추종 대상 = 연속 매수 2분기 이상 또는 8분기 중 2회 이상 매수(그 사이 매도 없음), 평가액 $150M 이상
//   최근 매수가 = 마지막 매수 분기 종가 최저가 +5%, Form 4·수기 뉴스 실단가가 있으면 그 가중평균
//   강력 추천 = 현재가(종가)가 최근 매수가 이하
// 로직을 앱에서 바꾸면 여기도 같이 바꿀 것 (docs/mopick-logic.md §2 참조).
//
// 필요 환경변수: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT(mailto:...),
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE (구독 목록 읽기·죽은 구독 정리용)
// 테스트: DRY_RUN=1 이면 발송하지 않고 메시지만 출력. RAW_BASE 로 데이터 소스 교체 가능.

import { readFile } from "node:fs/promises";
// web-push 는 실제 발송 때만 동적 로드 (DRY_RUN·시크릿 미설정이면 설치 없이도 계산까지 돌아가게)

const REPO = process.env.GITHUB_REPOSITORY || "geniusbyun-kaka/app";
const RAW = process.env.RAW_BASE || `https://raw.githubusercontent.com/${REPO}`;
const DRY = !!process.env.DRY_RUN;

const GURUS = [
  { id: "buffett", file: "berkshire.json", short: "버핏", name: "워렌 버핏" },
  { id: "ackman", file: "pershing.json", short: "애크먼", name: "빌 애크먼" },
  { id: "klarman", file: "baupost.json", short: "클라르만", name: "세스 클라르만" },
  { id: "loeb", file: "thirdpoint.json", short: "러브", name: "대니얼 러브" },
  { id: "einhorn", file: "greenlight.json", short: "아인혼", name: "데이비드 아인혼" },
  { id: "lilu", file: "himalaya.json", short: "리 루", name: "리 루" },
  { id: "mclemore", file: "patient.json", short: "매클레모어", name: "서맨사 매클레모어" },
  { id: "firsteagle", file: "firsteagle.json", short: "퍼스트 이글", name: "퍼스트 이글" },
];
const SHARE_CLASS_ALIAS = { GOOG: "GOOGL", "LEN-B": "LEN", "HEI-A": "HEI", "BRK-A": "BRK-B", LILAK: "LILA", LLYVK: "LLYVA" };
const alias = (t) => SHARE_CLASS_ALIAS[t] || t;
const FOLLOW_MIN_VALUE = 150e6;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

// ── 앱 공용 로직 포팅 ──
function analyzeFilings(f) {
  const qs = f.quarters.map((q) => ({ ...q, map: new Map(q.holdings.map((h) => [h.cusip, h])) }));
  qs.forEach((q, i) => {
    const prev = qs[i - 1];
    for (const h of q.holdings) {
      const p = prev?.map.get(h.cusip);
      if (!prev) { h.change = "first"; continue; }
      if (!p) { h.change = "new"; continue; }
      const r = h.shares / p.shares, vr = p.value ? h.value / p.value : null;
      if ((r >= 1.9 || r <= 0.55) && vr != null && Math.abs(vr / r - 1) > 0.35) { h.change = "split"; h.splitRatio = r; continue; }
      const pct = r - 1;
      h.change = pct > 0.005 ? "inc" : pct < -0.005 ? "dec" : "same";
    }
  });
  const latest = qs.at(-1);
  const isBuy = (c) => c === "inc" || c === "new";
  for (const h of latest.holdings) {
    let streak = 0;
    for (let i = qs.length - 1; i >= 0; i--) { const x = qs[i].map.get(h.cusip); if (x && isBuy(x.change)) streak++; else break; }
    h.streak = streak;
    const last8 = qs.slice(-8).map((q) => q.map.get(h.cusip)?.change || "none");
    h.buys8 = last8.filter(isBuy).length;
    h.sold8 = last8.some((c, i) => c === "dec" || (c === "none" && last8.slice(0, i).some((x) => x !== "none")));
  }
  return { quarters: qs, latest };
}
function guruBuys(qs, h) {
  const buys = []; let prevShares = null;
  for (const q of qs) {
    const x = q.map.get(h.cusip);
    if (!x) { prevShares = null; continue; }
    if (x.change === "split" && x.splitRatio) { for (const b of buys) b.shares *= x.splitRatio; }
    else if (x.change === "new") buys.push({ period: q.period, shares: x.shares });
    else if (x.change === "inc" && prevShares != null) buys.push({ period: q.period, shares: x.shares - prevShares });
    prevShares = x.shares;
  }
  return buys.filter((b) => b.shares > 0);
}
const quarterStart = (p) => `${p.slice(0, 4)}-${{ "03": "01", "06": "04", "09": "07", "12": "10" }[p.slice(5, 7)] || "01"}-01`;
function unpackDaily(daily) {
  const dates = [daily.d0]; let d = new Date(daily.d0);
  for (const g of daily.gaps) { d = new Date(d.getTime() + g * 86400000); dates.push(d.toISOString().slice(0, 10)); }
  return { dates, close: daily.close };
}
function quarterBuyEst(stock, period) {
  const a = quarterStart(period);
  let lo = Infinity;
  for (let i = 0; i < stock.dates.length; i++) { const dt = stock.dates[i]; if (dt >= a && dt <= period) { const c = stock.close[i]; if (c < lo) lo = c; } }
  return isFinite(lo) ? lo * 1.05 : null;
}
const evTickerMatch = (evTicker, ticker) => String(evTicker || "").split(/[,\s]+/).some((t) => t && alias(t.replace(/\./g, "-")) === alias(ticker));
const pricedEvDate = (e) => String(e.to || e.from || e.filed || e.date || "").slice(0, 10);
function pricedBuyEvents(evs, g, ticker) {
  return [
    ...(evs.auto || []).filter((e) => e.guru === g.file && e.side === "buy" && e.priceLow != null && evTickerMatch(e.ticker, ticker)),
    ...(evs.manual || []).filter((e) => e.side === "buy" && e.priceLow != null && evTickerMatch(e.ticker, ticker) && (String(e.guru || "").includes(g.short) || String(e.guru || "").includes(g.name))),
  ];
}
function applyPricedEvents(rec, events) {
  const cutoff = rec ? quarterStart(rec.period) : "";
  const newer = events.filter((e) => pricedEvDate(e) >= cutoff && pricedEvDate(e));
  if (!newer.length) return rec;
  let sh = 0, cost = 0, sum = 0, lastDate = "";
  for (const e of newer) {
    const mid = e.priceHigh > e.priceLow ? (e.priceLow + e.priceHigh) / 2 : e.priceLow;
    sum += mid;
    if (e.shares > 0) { sh += e.shares; cost += mid * e.shares; }
    if (pricedEvDate(e) > lastDate) lastDate = pricedEvDate(e);
  }
  return { period: lastDate, mid: sh > 0 ? cost / sh : sum / newer.length };
}

async function strongPicks() {
  const idx = await getJson(`${RAW}/stocks/index.json`);
  const priceOf = (t) => idx.items.find((x) => x.symbol === t)?.price ?? null;
  const auto = (await getJson(`${RAW}/filings/events.json`).catch(() => ({ events: [] }))).events || [];
  let manual = [];
  try { manual = JSON.parse(await readFile("invest/guru-news.json", "utf8")).items || []; } catch {}
  const evs = { auto, manual };
  const stockCache = new Map();
  const loadStock = async (t) => {
    if (!stockCache.has(t)) stockCache.set(t, getJson(`${RAW}/stocks/stocks/${t}.json`).then((s) => unpackDaily(s.daily)).catch(() => null));
    return stockCache.get(t);
  };
  const best = new Map(); // alias 티커 → 가장 할인 폭이 큰 강력 추천
  for (const g of GURUS) {
    let f;
    try { f = analyzeFilings(await getJson(`${RAW}/filings/${g.file}`)); } catch (err) { console.warn(`[push] ${g.file} 실패: ${err.message}`); continue; }
    const totalValue = f.latest.totalValue || f.latest.holdings.reduce((s, h) => s + h.value, 0);
    for (const h of f.latest.holdings) {
      if (!(h.streak >= 2 || (h.buys8 >= 2 && !h.sold8))) continue;
      if (h.value < FOLLOW_MIN_VALUE) continue;
      if (!h.ticker) continue;
      const buys = guruBuys(f.quarters, h);
      if (!buys.length) continue;
      const stock = await loadStock(h.ticker);
      if (!stock) continue;
      let recent = null;
      for (const b of buys) { const mid = quarterBuyEst(stock, b.period); if (mid != null) recent = { period: b.period, mid }; }
      if (!recent) continue;
      recent = applyPricedEvents(recent, pricedBuyEvents(evs, g, h.ticker));
      const cur = priceOf(h.ticker) ?? stock.close.at(-1);
      if (cur == null || !(recent.mid > 0)) continue;
      const rel = cur / recent.mid - 1;
      if (rel > 0) continue; // 강력 추천만: 최근 매수가 이하
      const key = alias(h.ticker);
      const prev = best.get(key);
      if (!prev || rel < prev.rel) best.set(key, { ticker: h.ticker, guru: g.short, cur, mid: recent.mid, rel, weight: totalValue ? h.value / totalValue : 0 });
    }
  }
  return [...best.values()].sort((a, b) => a.rel - b.rel).slice(0, 6);
}

// ── Supabase 구독 목록 · 웹 푸시 발송 ──
async function supabase(pathPart, init = {}) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${pathPart}`;
  const headers = { apikey: process.env.SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE}`, "Content-Type": "application/json", ...init.headers };
  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  const picks = await strongPicks();
  if (!picks.length) { console.log("[push] 오늘 종가 기준 강력 추천 없음 → 발송 안 함"); return; }
  const kst = new Date(Date.now() + 9 * 3600000);
  const title = `모픽 강력 추천 · ${kst.getUTCMonth() + 1}/${kst.getUTCDate()} 뉴욕 종가 기준`;
  const fmt$ = (v) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const body = picks.map((p) => `${p.ticker} 종가 ${fmt$(p.cur)} · ${p.guru} 최근 매수가 ${fmt$(p.mid)} 대비 ${(p.rel * 100).toFixed(1)}%`).join("\n");
  console.log(`[push] ${title}\n${body}`);
  if (DRY) { console.log("[push] DRY_RUN → 발송 생략"); return; }

  for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE"]) {
    if (!process.env[k]) { console.log(`[push] ${k} 미설정 → 발송 생략 (저장소 Secrets 에 등록하면 켜집니다)`); return; }
  }
  const webpush = (await import("web-push")).default;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const subs = await supabase("push_subscriptions?select=id,endpoint,p256dh,auth");
  console.log(`[push] 구독 기기 ${subs.length}개`);
  const payload = JSON.stringify({ title, body, tag: "mopick-strong-buy", url: "./#max" });
  let sent = 0, dead = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 12 * 3600 });
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) { // 앱 삭제·구독 만료 → 목록에서 정리
        dead++;
        try { await supabase(`push_subscriptions?id=eq.${s.id}`, { method: "DELETE" }); } catch {}
      } else console.warn(`[push] 발송 실패 (${err.statusCode || err.message})`);
    }
  }
  console.log(`[push] 발송 ${sent}건, 만료 정리 ${dead}건`);
}

main().catch((err) => { console.error(err); process.exit(1); });
