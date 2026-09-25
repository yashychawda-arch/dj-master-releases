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

// Bookkeeping for the page: the latest requests, and how to reach DJ Master right now.
async function remember(alert, request) {
  const state = await readState();
  state.paired = true;
  state.dj = alert.dj || state.dj || "";
  state.accent = alert.accent || state.accent || "";
  state.pt = alert.pt || state.pt || "";
  // The booth link's address changes each time it opens; every alert carries the current one.
  if ("via" in alert) state.via = alert.via || "";
  if (request) {
    const item = { id: request, title: alert.title || "A song", sub: alert.sub || "", art: alert.art || "", at: Date.now() };
    state.requests = [item, ...(state.requests || []).filter((r) => r.id !== item.id)].slice(0, 20);
  }
  await writeState(state);
  const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  open.forEach((w) => w.postMessage({ type: "alert", id: request }));
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

self.addEventListener("push", (event) => {
  let alert = {};
  try { alert = event.data ? event.data.json() : {}; } catch (e) { alert = {}; }
  const request = alert.kind === "request" && alert.id ? String(alert.id) : null;
  // The notification goes up first, before storage is touched. An iPhone waking this worker for a push
  // can stall on storage, and a notification queued behind it only appeared when the next push arrived.
  const shown = self.registration.showNotification(request ? "New song request" : alert.title || "DJ Master", {
    body: request ? [alert.title, alert.sub].filter(Boolean).join(" · ") : alert.sub || "",
    tag: request ? "req-" + request : "djm-note-" + Date.now(),
    renotify: true,
    icon: "icon-180.png",
    badge: "icon-180.png",
    data: { id: request, alert },
  });
  // The bookkeeping gets a few seconds, never the power to hold the notification or the worker up.
  event.waitUntil(Promise.all([shown, Promise.race([remember(alert, request).catch(() => {}), pause(4000)])]));
});

// Tapping the notification opens the "Waiting on you" page, on the request that was tapped.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const id = data.id || null;
  const url = new URL(id ? "./?req=" + encodeURIComponent(id) : "./", self.registration.scope).href;
  event.waitUntil((async () => {
    // In case the push's own bookkeeping never finished: the page needs the booth link's address.
    if (data.alert) await Promise.race([remember(data.alert, id).catch(() => {}), pause(1500)]);
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of open) {
      w.postMessage({ type: "open", id });
      if ("focus" in w) return w.focus();
    }
    return self.clients.openWindow(url);
  })());
});
