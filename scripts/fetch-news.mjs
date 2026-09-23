#!/usr/bin/env node
// CNBC 월드 메인 페이지(https://www.cnbc.com/world/)의 상위 3개 기사를 받아
// 제목·핵심 포인트·본문을 한국어로 번역해 `news` 브랜치에 저장한다.
// GitHub Actions 에서 매일 한국시간 오전 6시(21:00 UTC)에 실행된다.
//
// 결과물 (출력 폴더 기준):
//   news.json   { updated, source, articles: [{ url, title, titleKo, image, published, keyPointsKo, bodyKo, note }] }
//
// 사용법: node scripts/fetch-news.mjs [출력폴더]
//   NEWS_COUNT=3   가져올 기사 수 (기본 3)
//   NEWS_PARAS=12  기사당 번역할 최대 문단 수 (기본 12. 전문 재게시는 저작권 문제가 있어 일부만)

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = process.argv[2] || "news-out";
const HOME = "https://www.cnbc.com/world/";
const RSS_TOP = "https://www.cnbc.com/id/100727362/device/rss/rss.html"; // World News RSS (폴백)
const COUNT = Number(process.env.NEWS_COUNT || 3);
const MAX_PARAS = Number(process.env.NEWS_PARAS || 12);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*", "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow" });
      if (res.ok) return res.text();
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (i + 1)); continue; }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) { if (i === 2) throw err; await sleep(2000 * (i + 1)); }
  }
  throw new Error(`응답 없음: ${url}`);
}

// HTML 엔티티 최소 디코딩
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&rsquo;/g, "’").replace(/&lsquo;/g, "‘").replace(/&rdquo;/g, "”").replace(/&ldquo;/g, "“")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&hellip;/g, "…");
}
const stripTags = (s) => decode(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

const ARTICLE_RE = /https:\/\/www\.cnbc\.com\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+\.html/g;

// 메인 페이지에서 노출 순서대로 기사 링크를 뽑는다.
// 1순위: 페이지에 심긴 레이아웃 JSON (window.__s_data) 을 순회하며 기사 URL 수집
// 2순위: HTML 에 나타나는 순서대로 날짜형 기사 링크
// 3순위: World News RSS
async function topLinks() {
  let html = "";
  try { html = await fetchText(HOME); } catch (err) { console.warn(`[news] 메인 페이지 실패: ${err.message}`); }
  const seen = new Set(), out = [];
  const push = (u) => { if (u && !seen.has(u) && !/\/(video|select|pro)\//.test(u)) { seen.add(u); out.push(u); } };
  const jsonBlob = html.match(/window\.__s_data\s*=\s*(\{.*?\});\s*window\.__c_data/s) || html.match(/window\.__s_data\s*=\s*(\{.*?\});\n/s);
  if (jsonBlob) {
    try {
      const walk = (node) => {
        if (out.length >= COUNT * 3 || node == null) return;
        if (Array.isArray(node)) { for (const x of node) walk(x); return; }
        if (typeof node === "object") {
          if (typeof node.url === "string" && /cnbcnewsstory|article/i.test(String(node.type || ""))) { const m = node.url.match(ARTICLE_RE); if (m) push(m[0]); }
          for (const k of Object.keys(node)) walk(node[k]);
        }
      };
      walk(JSON.parse(jsonBlob[1]));
      if (out.length) console.log(`[news] 레이아웃 JSON 에서 ${out.length}개 링크`);
    } catch (err) { console.warn(`[news] 레이아웃 JSON 파싱 실패: ${err.message}`); }
  }
  if (out.length < COUNT && html) for (const m of html.matchAll(ARTICLE_RE)) { push(m[0]); if (out.length >= COUNT * 3) break; }
  if (out.length < COUNT) {
    console.warn("[news] 메인 페이지에서 링크를 못 찾아 RSS 로 폴백");
    const rss = await fetchText(RSS_TOP);
    for (const m of rss.matchAll(/<link>\s*(https:\/\/www\.cnbc\.com\/\d{4}\/[^<\s]+)\s*<\/link>/g)) push(m[1]);
  }
  return out.slice(0, COUNT);
}

const meta = (html, prop) => {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, "i")) || html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${prop}"`, "i"));
  return m ? decode(m[1]) : null;
};

function parseArticle(html, url) {
  const title = meta(html, "og:title") || stripTags((html.match(/<h1[^>]*>(.*?)<\/h1>/s) || [, ""])[1]);
  const desc = meta(html, "og:description") || "";
  const image = meta(html, "og:image");
  const published = meta(html, "article:published_time");
  // 핵심 포인트 (Key Points 박스)
  const keyPoints = [];
  const kp = html.match(/RenderKeyPoints[\s\S]{0,6000}?<\/ul>/);
  if (kp) for (const li of kp[0].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) { const t = stripTags(li[1]); if (t) keyPoints.push(t); }
  // 본문 문단
  const paras = [];
  const bodyStart = html.indexOf("ArticleBody-articleBody");
  if (bodyStart >= 0) {
    const body = html.slice(bodyStart, html.indexOf("RelatedContent", bodyStart) > 0 ? html.indexOf("RelatedContent", bodyStart) : undefined);
    for (const p of body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
      const t = stripTags(p[1]);
      if (!t || t.length < 3) continue;
      if (/^(Subscribe to|Sign up for|Watch CNBC|Read more|Correction:|Clarification:|Disclosure:|Don't miss)/i.test(t)) continue;
      paras.push(t);
      if (paras.length >= MAX_PARAS) break;
    }
  }
  return { url, title, desc, image, published, keyPoints, paras };
}

// Google 번역 비공식 엔드포인트 (무료·무키). 하루 수십 건 수준이라 충분하다.
async function toKorean(text) {
  if (!text?.trim()) return "";
  const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=${encodeURIComponent(text)}`;
  for (let i = 0; i < 3; i++) {
    try {
      await sleep(300);
      const res = await fetch(u, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const out = (j?.[0] || []).map((seg) => seg?.[0] || "").join("").trim();
      if (out) return out;
      throw new Error("빈 응답");
    } catch (err) { if (i === 2) { console.warn(`[news] 번역 실패: ${err.message} — 원문 유지`); return null; } await sleep(1500 * (i + 1)); }
  }
  return null;
}

async function main() {
  const links = await topLinks();
  if (!links.length) throw new Error("기사 링크를 하나도 찾지 못했습니다");
  console.log(`[news] 상위 기사:\n  ${links.join("\n  ")}`);
  const articles = [];
  for (const url of links) {
    try {
      const a = parseArticle(await fetchText(url), url);
      let note = null;
      if (!a.paras.length) { note = "본문을 가져오지 못해 요약만 표시합니다 (유료 기사이거나 형식이 다른 페이지)"; if (a.desc) a.paras = [a.desc]; }
      const titleKo = (await toKorean(a.title)) || a.title;
      const keyPointsKo = [];
      for (const k of a.keyPoints) keyPointsKo.push((await toKorean(k)) || k);
      const bodyKo = [];
      for (const p of a.paras) bodyKo.push((await toKorean(p)) || p);
      articles.push({ url, title: a.title, titleKo, image: a.image, published: a.published, keyPointsKo, bodyKo, note });
      console.log(`[news] 완료: ${a.title} (핵심 ${keyPointsKo.length} · 문단 ${bodyKo.length})`);
    } catch (err) {
      console.warn(`[news] 기사 실패 ${url}: ${err.message}`);
      articles.push({ url, title: url, titleKo: null, image: null, published: null, keyPointsKo: [], bodyKo: [], note: `기사를 가져오지 못했습니다 (${err.message})` });
    }
  }
  const out = { updated: new Date().toISOString(), source: "CNBC World", home: HOME, maxParas: MAX_PARAS, articles };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "news.json"), JSON.stringify(out, null, 1));
  console.log(`[news] ${path.join(OUT_DIR, "news.json")} 저장 (기사 ${articles.length}건)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
