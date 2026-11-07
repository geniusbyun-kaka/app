// 버핏 판정 시리즈의 공개 순서 고정.
// 시총 순서를 매주 라이브 값으로 다시 짜면 시총이 뒤집힌 종목이 이미 공개한 회차 자리로 끼어들고
// 공개했던 종목이 화면에서 사라진다 (2026-11-07 셀트리온·삼천당제약이 4회차로 끼어들고 5회차였던
// 삼성SDI·원익IPS가 사라진 사례). 그래서 공개된 회차의 종목은 joker-verdicts.json 의 published
// (시장별 티커 순서)에 기록해 두고 이후 실행에서도 그 순서를 그대로 지킨다.

export const SERIES_START = "2026-10-05"; // 첫 공개 주의 월요일 (KST)

// published 가 아직 없는 첫 실행용 초기값: 2026-11-02(5회차)까지 실제로 공개된 종목
export const PUBLISHED_SEED = {
  kospi: ["005930", "000660", "005380", "028260", "006400"], // 삼성전자 · SK하이닉스 · 현대차 · 삼성물산 · 삼성SDI
  kosdaq: ["196170", "086520", "028300", "039030", "240810"], // 알테오젠 · 에코프로 · HLB · 이오테크닉스 · 원익IPS
};

export const judgeable = (r) => !!r && (r.verdict === "pass" || r.verdict === "fail");

// 이미 공개된 회차 수 (월요일 00:00 KST 에 다음 회차가 열린다)
export function publishedEpisodes(now) {
  return Math.max(0, Math.floor((now - new Date(`${SERIES_START}T00:00:00+09:00`)) / 6048e5)) + 1;
}

// live: 이번 실행의 시총 순서 행 목록(판정 불가 행은 kr-topcap.json 자리를 지킨 채 끼어 있음)
// published: 고정된 티커 순서, prevRows: 직전 joker-verdicts.json 의 같은 시장 행, target: 확정할 회차 수
// 반환: { rows, published } — rows 는 판정 가능 종목이 고정 순서(그다음 시총 순)로 놓인 목록
export function freezeSeries(live, published, prevRows, target) {
  const byTicker = new Map(live.map((r) => [r.ticker, r]));
  const prev = new Map((prevRows || []).map((r) => [r.ticker, r]));
  const ledger = [];
  for (const t of published || []) if (t && !ledger.includes(t)) ledger.push(t);
  // 다음 월요일 회차까지 확정: 아직 고정되지 않은 판정 가능 종목을 시총 순으로 이어 붙인다
  const queue = live.filter((r) => judgeable(r) && !ledger.includes(r.ticker));
  while (ledger.length < target && queue.length) ledger.push(queue.shift().ticker);
  // 고정 종목이 이번 판정에서 일시적으로 판정 불가가 됐어도(데이터 장애) 공개했던 행을 그대로 쓴다
  const rowOf = (t) => {
    const r = byTicker.get(t);
    if (judgeable(r)) return r;
    const p = prev.get(t);
    return judgeable(p) ? p : null;
  };
  const frozenRows = ledger.map(rowOf).filter(Boolean);
  const frozenSet = new Set(ledger);
  const seq = [...frozenRows, ...live.filter((r) => judgeable(r) && !frozenSet.has(r.ticker))];
  const rows = [];
  let p = 0;
  for (const r of live) {
    if (judgeable(r)) { if (p < seq.length) rows.push(seq[p++]); }
    else if (!frozenSet.has(r.ticker)) rows.push(r); // 판정 불가 행은 원래 자리(앞선 판정 가능 종목 수)를 지킨다
  }
  while (p < seq.length) rows.push(seq[p++]);
  return { rows, published: ledger };
}
