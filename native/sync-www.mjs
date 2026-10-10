#!/usr/bin/env node
// 모픽 웹앱(../invest)을 Capacitor 의 webDir(www)로 복사한다.
// 앱은 상대 경로(lessons.json 등)와 절대 URL(raw.githubusercontent.com 데이터 브랜치,
// Supabase)만 쓰므로 파일을 그대로 복사하면 네이티브 셸 안에서도 동작한다.
// 사용법: node sync-www.mjs  (또는 npm run sync-www)
import { cp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "invest");
const OUT = path.join(here, "www");

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await cp(SRC, OUT, { recursive: true });

// 네이티브 셸 표시: 앱 쪽에서 window.MOPICK_NATIVE 로 분기할 수 있게 작은 플래그를 심는다
// (예: "홈 화면에 추가" 안내 숨기기, 웹 푸시 대신 네이티브 푸시 쓰기)
const indexPath = path.join(OUT, "index.html");
let html = await readFile(indexPath, "utf8");
html = html.replace("<head>", "<head>\n<script>window.MOPICK_NATIVE = true;</script>");
await writeFile(indexPath, html);

console.log(`[native] ${SRC} → ${OUT} 복사 완료`);
