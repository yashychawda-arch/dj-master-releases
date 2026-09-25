// DJ Master Alerts: shows each song request as a notification, and keeps the latest ones so the page
// can list them - even when the page itself isn't open. Every alert is encrypted to this phone's keys
// by DJ Master on the DJ's computer; the push service in between can't read it.

const CACHE = "djm-alerts";
const STATE = "./state.json";

async function readState() {
  try {
    const hit = await (await caches.open(CACHE)).match(STATE);
    return hit ? await hit.json() : {};
  } catch (e) { return {}; }
}

async function writeState(state) {
  const cache = await caches.open(CACHE);
  await cache.put(STATE, new Response(JSON.stringify(state), { headers: { "Content-Type": "application/json" } }));
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let alert = {};
  try { alert = event.data ? event.data.json() : {}; } catch (e) { alert = {}; }
  event.waitUntil((async () => {
    const state = await readState();
    state.paired = true;
    state.dj = alert.dj || state.dj || "";
    state.accent = alert.accent || state.accent || "";
    state.pt = alert.pt || state.pt || "";
    // The booth link's address changes each time it opens; every alert carries the current one.
    if ("via" in alert) state.via = alert.via || "";
    const request = alert.kind === "request" && alert.id;
    if (request) {
      const item = { id: String(alert.id), title: alert.title || "A song", sub: alert.sub || "", art: alert.art || "", at: Date.now() };
      state.requests = [item, ...(state.requests || []).filter((r) => r.id !== item.id)].slice(0, 20);
    }
    await writeState(state);
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    open.forEach((w) => w.postMessage({ type: "alert", id: request ? String(alert.id) : null }));
    await self.registration.showNotification(request ? "New song request" : alert.title || "DJ Master", {
      body: request ? [alert.title, alert.sub].filter(Boolean).join(" · ") : alert.sub || "",
      tag: request ? "req-" + alert.id : "djm-note",
      renotify: true,
      icon: "icon-180.png",
      badge: "icon-180.png",
      data: { id: request ? String(alert.id) : null },
    });
  })());
});

// Tapping the notification opens the "Waiting on you" page, on the request that was tapped.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = (event.notification.data || {}).id;
  const url = new URL(id ? "./?req=" + encodeURIComponent(id) : "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of open) {
      w.postMessage({ type: "open", id });
      if ("focus" in w) return w.focus();
    }
    return self.clients.openWindow(url);
  })());
});
