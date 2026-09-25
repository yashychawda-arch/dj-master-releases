// DJ Master Alerts. Pairs this phone with DJ Master (from the QR code on the DJ's computer), then lists
// the requests waiting on the DJ and answers them - Play it or No - through the booth link.
// Everything a stranger typed (song titles) is only ever set as text, never as markup.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const params = new URLSearchParams(location.search);
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const CACHE = "djm-alerts";
  const STATE = "./state.json";
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: pairing still works */ } },
  };
  const normal = (code) => String(code || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  const pretty = (code) => { const c = normal(code); return c.length > 3 ? c.slice(0, 3) + " " + c.slice(3) : c; };
  // Which computer this phone pairs with. An iPhone only ever opens its Home Screen app at the address
  // it was added with, so a later pairing - a new code typed in - has to work from what was kept here.
  const fromUrl = /^https?:\/\//.test(params.get("pc") || "") && params.get("key")
    ? { pc: params.get("pc"), key: params.get("key"), dj: params.get("dj") || "", accent: params.get("accent") || "" } : null;
  if (fromUrl) store.set("computer", JSON.stringify(fromUrl));
  const computer = fromUrl || (() => { try { return JSON.parse(store.get("computer") || "null"); } catch (e) { return null; } })();
  const urlCode = normal(params.get("pair"));
  // A code in the address gets one go: once anything has been tried from this address, it's spent - the
  // pairing may have gone through with a code typed in instead. Old-style codes (before 1.21.0's six
  // letters) never count.
  const fresh = () => urlCode.length === 6 && store.get("spent") !== urlCode;
  let wanted = params.get("req");
  async function readState() {
    try {
      const hit = await (await caches.open(CACHE)).match(STATE);
      return hit ? await hit.json() : {};
    } catch (e) { return {}; }
  }
  async function writeState(s) {
    try {
      await (await caches.open(CACHE)).put(STATE, new Response(JSON.stringify(s), { headers: { "Content-Type": "application/json" } }));
    } catch (e) { /* the list is rebuilt from DJ Master next time */ }
  }

  function accent(hex) {
    if (/^#[0-9a-f]{6}$/i.test(hex || "")) document.documentElement.style.setProperty("--accent", hex);
  }
  function show(id) {
    for (const s of ["pair", "waiting", "unpaired"]) $(s).hidden = s !== id;
    $("foot").hidden = id !== "waiting";
  }
  function say(node, text, kind) {
    node.textContent = text || "";
    node.className = "status" + (kind ? " " + kind : "");
  }
  const b64u = (text) => btoa(unescape(encodeURIComponent(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  function keyBytes(text) {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }
  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPad/.test(ua)) return "iPad";
    if (/iPhone/.test(ua)) return "iPhone";
    return /Android/.test(ua) ? "Android phone" : "Phone";
  }

  // ---------- pairing ----------
  function showPair(code) {
    accent(computer.accent);
    $("who").textContent = computer.dj || "";
    const homeFirst = isIOS && !standalone;
    $("ios-steps").hidden = !homeFirst;
    $("ios-why").hidden = !homeFirst;
    $("turn-on").hidden = homeFirst;
    $("code-field").hidden = homeFirst;
    $("turn-on").disabled = false;
    $("code").value = pretty(code);
    // Just tried, and nothing has arrived yet: say so, rather than asking for a code all over again.
    const recent = store.get("tried") && Date.now() - Number(store.get("triedAt") || 0) < 10 * 60000;
    say($("pair-status"), code || homeFirst ? ""
      : recent ? "Waiting for DJ Master's test alert. If nothing arrives in a minute, press Test in DJ Master - or type a new code and turn alerts on again."
      : "Type the code DJ Master shows under Phone > Request alerts.");
    show("pair");
  }

  async function turnOn() {
    const button = $("turn-on");
    const out = $("pair-status");
    const code = normal($("code").value);
    if (code.length !== 6) {
      $("code").focus();
      return say(out, "Type the six-character code DJ Master shows under Phone > Request alerts.", "warn");
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      return say(out, isIOS ? "Open DJ Alerts from your Home Screen first. Safari itself can't show these."
                            : "This browser can't show alerts. On Android, open this page in Chrome.", "warn");
    }
    // Asked first, while the tap still counts: phones only show this prompt in answer to a tap.
    const permission = Notification.requestPermission();
    button.disabled = true;
    say(out, "Asking your phone…");
    try {
      const reg = await navigator.serviceWorker.register("sw.js");
      if ((await permission) !== "granted") {
        button.disabled = false;
        return say(out, "Notifications are off for DJ Alerts. Turn them on in your phone's Settings, then try again.", "warn");
      }
      await navigator.serviceWorker.ready;
      const old = await reg.pushManager.getSubscription();
      if (old) await old.unsubscribe();                 // a fresh address, tied to this computer's key
      const sub = (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(computer.key) })).toJSON();
      store.set("tried", code);
      store.set("triedAt", String(Date.now()));
      if (urlCode) store.set("spent", urlCode);
      // Paired means an alert has actually arrived - the service worker marks it when DJ Master's test
      // alert lands. Until then this phone doesn't claim to be listening.
      const s = await readState();
      Object.assign(s, { paired: false, dj: computer.dj, accent: computer.accent });
      await writeState(s);
      say(out, "Handing this phone's alert address to DJ Master…", "good");
      // A plain-http address on your Wi-Fi can't be called from this page, but it can be opened.
      location.href = computer.pc.replace(/\/+$/, "") + "/alerts/pair?" + new URLSearchParams({
        code, sub: b64u(JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys })), name: deviceName() });
    } catch (e) {
      button.disabled = false;
      say(out, "Couldn't turn alerts on: " + ((e && e.message) || e), "warn");
    }
  }

  // ---------- what's waiting ----------
  let state = {};
  const base = () => (state.via || "").replace(/\/+$/, "");

  function ago(ms) {
    if (!ms) return "";
    const m = Math.round((Date.now() - ms) / 60000);
    return m < 1 ? "asked just now" : m < 60 ? `asked ${m} min ago` : `asked ${Math.floor(m / 60)} h ago`;
  }

  function card(r, first) {
    const box = el("div", "req" + (first ? " first" : ""));
    box.id = "r-" + r.id;
    const row = el("div", "req-row");
    let cover = el("span", "cover");
    if (/^https:\/\//.test(r.art || "")) {
      const img = el("img", "cover");
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.onerror = () => img.replaceWith(el("span", "cover"));
      img.src = r.art;
      cover = img;
    }
    const words = el("div");
    words.append(el("b", null, r.title || "A song"), el("small", null, [r.sub, ago(r.at)].filter(Boolean).join(" · ")));
    row.append(cover, words);
    const acts = el("div", "acts");
    const play = el("button", "play", "Play it");
    const no = el("button", "no", "No");
    play.type = no.type = "button";
    play.onclick = () => answer(r, "play", box);
    no.onclick = () => answer(r, "no", box);
    acts.append(play, no);
    box.append(row, acts);
    return box;
  }

  function render(list) {
    // The request you tapped goes to the top, so it's the one under your thumb.
    const tapped = list.find((r) => r.id === wanted);
    if (tapped) list = [tapped, ...list.filter((r) => r !== tapped)];
    $("list").replaceChildren(...list.map((r, i) => card(r, i === 0)));
    $("empty").hidden = list.length > 0;
    const hit = wanted && document.getElementById("r-" + wanted);
    if (hit) {
      hit.scrollIntoView({ block: "center" });
      hit.classList.add("lit");
    }
  }

  async function answer(r, action, box) {
    const buttons = box.querySelectorAll("button");
    buttons.forEach((b) => (b.disabled = true));
    try {
      if (!base()) throw new Error("offline");
      const res = await fetch(base() + "/alerts/act", {
        method: "POST", headers: { "Content-Type": "application/json", "X-DJ-Phone": state.pt || "" },
        body: JSON.stringify({ job: r.id, action }) });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "That didn't go through.");
      box.querySelector(".acts").replaceWith(el("div", "done" + (action === "no" ? " no-go" : ""),
        action === "play" ? "Playing it · downloading now" : "Turned down"));
      state.requests = (state.requests || []).filter((x) => x.id !== r.id);
      writeState(state);
      setTimeout(() => {
        box.classList.add("leaving");
        setTimeout(() => { box.remove(); $("empty").hidden = $("list").children.length > 0; }, 420);
      }, 1400);
      say($("status"), "");
    } catch (e) {
      buttons.forEach((b) => (b.disabled = false));
      const msg = e && e.message;
      say($("status"), msg && msg !== "offline" && !/fetch|network|load failed/i.test(msg) ? msg
        : "Can't reach DJ Master right now. Is your booth link still open?", "warn");
    }
  }

  async function refresh() {
    if (!base() || !state.pt) {
      say($("status"), state.via === "" ? "Your booth link is closed, so no new requests can come in right now." : "");
      return;
    }
    try {
      const res = await fetch(base() + "/alerts/list", { headers: { "X-DJ-Phone": state.pt }, cache: "no-store" });
      const data = await res.json();
      if (res.status === 401) return say($("status"), data.error || "This phone isn't paired any more.", "warn");
      if (!data.ok) throw new Error(data.error);
      state.requests = (data.requests || []).map((x) => ({ id: String(x.id), title: x.title, sub: x.sub, art: x.art, at: (x.added || 0) * 1000 }));
      state.dj = data.dj || state.dj;
      state.accent = data.accent || state.accent;
      accent(state.accent);
      $("who").textContent = state.dj || "";
      await writeState(state);
      render(state.requests);
      say($("status"), "");
    } catch (e) {
      say($("status"), "Can't reach DJ Master right now. If your booth link has closed, requests can't come in until it's open again.", "warn");
    }
  }

  async function load() {
    state = await readState();
    accent(state.accent);
    $("who").textContent = state.dj || "";
    render(state.requests || []);
    refresh();
  }

  // ---------- start ----------
  // Which screen: the list once an alert has arrived; pairing while there's a computer to pair with;
  // otherwise, how to start. A code in the address that hasn't been tried always gets its chance.
  async function route() {
    const saved = await readState();
    if (saved.paired && !fresh()) {
      show("waiting");
      return load();
    }
    if (computer) return showPair(fresh() ? urlCode : "");
    show("unpaired");
  }
  // Back from DJ Master's "Alerts are on" page, or its test alert just landed: on to the list.
  async function maybePaired() {
    if (!$("pair").hidden && store.get("tried") && !fresh() && (await readState()).paired) route();
  }

  $("turn-on").onclick = turnOn;
  $("code").addEventListener("keydown", (e) => { if (e.key === "Enter") turnOn(); });
  $("pair-again").onclick = () => (computer ? showPair("") : show("unpaired"));
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (!e.data || !(e.data.type === "alert" || e.data.type === "open")) return;
      if (e.data.type === "open" && e.data.id) wanted = e.data.id;
      if (!$("waiting").hidden) load();
      else maybePaired();
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (!$("waiting").hidden) load();
    else maybePaired();
  });
  addEventListener("pageshow", (e) => { if (e.persisted) maybePaired(); });
  setInterval(() => { if (!document.hidden && !$("waiting").hidden) refresh(); }, 30000);
  route();
})();
