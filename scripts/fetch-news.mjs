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
// 후보 링크를 넉넉히 모아 돌려준다 (유료 기사 등은 본문 단계에서 걸러 다음 후보로 넘어간다)
async function topLinks(debug) {
  let html = "";
  try { html = await fetchText(HOME); } catch (err) { console.warn(`[news] 메인 페이지 실패: ${err.message}`); }
  const seen = new Set(), out = [];
  const push = (u, why) => { if (u && !seen.has(u) && !/\/(video|select|pro)\//.test(u)) { seen.add(u); out.push(u); debug.candidates.push({ url: u, why }); } };
  // 1순위: 레이아웃 JSON 에서 히어로/피처드 모듈의 기사만, 모듈 순서대로
  const jsonBlob = html.match(/window\.__s_data\s*=\s*(\{.*?\});\s*window\.__c_data/s) || html.match(/window\.__s_data\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (jsonBlob) {
    try {
      const data = JSON.parse(jsonBlob[1]);
      const modules = [];
      (function walk(node) {
        if (node == null) return;
        if (Array.isArray(node)) { for (const x of node) walk(x); return; }
        if (typeof node === "object") {
          if (typeof node.name === "string" && Array.isArray(node.data?.assets || node.assets)) modules.push({ name: node.name, assets: node.data?.assets || node.assets });
          for (const k of Object.keys(node)) walk(node[k]);
        }
      })(data);
      debug.modules = modules.map((m) => `${m.name}(${m.assets.length})`);
      const heroFirst = [...modules.filter((m) => /hero|featured|river|top/i.test(m.name)), ...modules];
      for (const m of heroFirst) for (const a of m.assets) {
        if (a?.premium === true || /premium|pro/i.test(String(a?.contentClassification || ""))) continue;
        const u = String(a?.url || "").match(ARTICLE_RE); if (u) push(u[0], `module:${m.name}`);
      }
      if (out.length) console.log(`[news] 레이아웃 JSON 모듈에서 ${out.length}개 링크`);
    } catch (err) { console.warn(`[news] 레이아웃 JSON 파싱 실패: ${err.message}`); debug.jsonError = err.message; }
  } else debug.jsonError = "__s_data 블롭을 못 찾음";
  // 2순위: RSS World News (편집 순서라 상위가 곧 주요 기사)
  if (out.length < COUNT * 2) {
    try {
      const rss = await fetchText(RSS_TOP);
      for (const m of rss.matchAll(/<link>\s*(https:\/\/www\.cnbc\.com\/\d{4}\/[^<\s]+)\s*<\/link>/g)) { push(m[1], "rss"); if (out.length >= COUNT * 3) break; }
    } catch (err) { console.warn(`[news] RSS 실패: ${err.message}`); }
  }
  // 3순위: HTML 등장 순서
  if (out.length < COUNT && html) for (const m of html.matchAll(ARTICLE_RE)) { push(m[0], "html-order"); if (out.length >= COUNT * 3) break; }
  return out;
}

const meta = (html, prop) => {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, "i")) || html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${prop}"`, "i"));
  return m ? decode(m[1]) : null;
};

// 문장 단위로 잘라 2~3문장씩 문단으로 묶는다 (articleBody 가 통짜 문자열일 때)
function toParas(text) {
  const sents = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+(?:["\u201d']+)?(?:\s|$)/g) || [text];
  const paras = []; let cur = "";
  for (const sn of sents) { cur += sn; if (cur.length > 320) { paras.push(cur.trim()); cur = ""; } }
  if (cur.trim()) paras.push(cur.trim());
  return paras;
}
function parseArticle(html, url, debug) {
  const title = meta(html, "og:title") || stripTags((html.match(/<h1[^>]*>(.*?)<\/h1>/s) || [, ""])[1]);
  const desc = meta(html, "og:description") || "";
  const image = meta(html, "og:image");
  const published = meta(html, "article:published_time");
  // 유료(PRO) 기사면 건너뛴다
  const premium = /"isAccessibleForFree"\s*:\s*"?false"?/i.test(html) || /"contentClassification"\s*:\s*"(premium|pro)"/i.test(html);
  // 핵심 포인트 (Key Points 박스) — 실제 렌더된 클래스만
  const keyPoints = [];
  const kp = html.match(/class="RenderKeyPoints[^"]*"[\s\S]{0,6000}?<\/ul>/);
  if (kp) for (const li of kp[0].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) { const t = stripTags(li[1]); if (t) keyPoints.push(t); }
  // 본문: 1순위 ld+json 의 articleBody, 2순위 렌더된 ArticleBody 영역의 <p>
  let paras = [], via = null;
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1].trim());
      for (const node of Array.isArray(j) ? j : [j]) {
        const bodyTxt = node?.articleBody || node?.["@graph"]?.find?.((g) => g.articleBody)?.articleBody;
        if (typeof bodyTxt === "string" && bodyTxt.length > 200) { paras = toParas(decode(bodyTxt)); via = "ld+json"; break; }
      }
    } catch {}
    if (paras.length) break;
  }
  if (!paras.length) {
    const bodyStart = html.search(/class="ArticleBody-articleBody[^"]*"/);
    if (bodyStart >= 0) {
      const rel = html.indexOf("RelatedContent", bodyStart);
      const body = html.slice(bodyStart, rel > 0 ? rel : bodyStart + 120000);
      for (const p of body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
        const t = stripTags(p[1]);
        if (!t || t.length < 30) continue;
        paras.push(t);
      }
      if (paras.length) via = "html";
    }
  }
  paras = paras.filter((t) => !/^(Subscribe to|Sign up for|Watch CNBC|Read more|Correction:|Clarification:|Disclosure:|Don't miss|Got a confidential)/i.test(t)).slice(0, MAX_PARAS);
  if (debug) debug.articles.push({ url, premium, via, kp: keyPoints.length, paras: paras.length, first: (paras[0] || "").slice(0, 160) });
  return { url, title, desc, image, published, keyPoints, paras, premium, via };
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
  const debug = { candidates: [], modules: [], articles: [] };
  const links = await topLinks(debug);
  if (!links.length) throw new Error("기사 링크를 하나도 찾지 못했습니다");
  console.log(`[news] 후보 기사 ${links.length}개:\n  ${links.join("\n  ")}`);
  const articles = [];
  for (const url of links) {
    if (articles.length >= COUNT) break;
    try {
      const a = parseArticle(await fetchText(url), url, debug);
      if (a.premium) { console.log(`[news] 유료 기사 건너뜀: ${url}`); continue; }
      let note = null;
      if (!a.paras.length) { note = "본문을 가져오지 못해 요약만 표시합니다"; if (a.desc) a.paras = [a.desc]; else continue; }
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
  if (process.env.NEWS_DEBUG) await writeFile(path.join(OUT_DIR, "debug.json"), JSON.stringify(debug, null, 1));
  console.log(`[news] ${path.join(OUT_DIR, "news.json")} 저장 (기사 ${articles.length}건)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
