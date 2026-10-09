// 모픽 서비스 워커: 푸시 알림 수신 전용 (오프라인 캐시는 하지 않는다 — 데이터가 늘 최신이어야 해서).
// push-alerts 워크플로가 보낸 메시지를 받아 시스템 알림으로 띄우고, 누르면 앱(매수 가격 따라가기)을 연다.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data ? e.data.text() : "" }; }
  const title = data.title || "모픽 알림";
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: data.tag || "mopick-strong-buy", // 같은 태그면 알림이 쌓이지 않고 교체된다
    data: { url: data.url || "./" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
