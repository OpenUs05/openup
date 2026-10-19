/* OpenUS add-on: two-phone sync + live GPS arrive/leave notifications.
   It works alongside the app without changing it: it watches the app's own saved data,
   keeps it in step between phones, and adds two cards (Sync, Live GPS) to existing screens.
   Each page sets window.OPENUS_SYNC before loading this file (see bottom of index.html). */
(function () {
  'use strict';
  // Fresh-start link: openus-app.netlify.app/?fresh clears everything saved on this phone
  // (names, photos, data, sync) and reopens the app blank.
  if (/[?&]fresh\b/.test(location.search)) {
    try { ['openusAppV2', 'openusV2', 'openusSafetyDemo', 'openusSync', 'openusGPS', 'openusGpsSeen'].forEach((k) => localStorage.removeItem(k)); } catch (e) {}
    location.replace(location.pathname);
    return;
  }
  const cfg = window.OPENUS_SYNC;
  if (!cfg) return;
  const GPS_KEY = 'openusGPS', META_KEY = 'openusSync';
  const KEYS = [...cfg.keys, GPS_KEY];
  const rawSet = Storage.prototype.setItem, rawRemove = Storage.prototype.removeItem;
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { v == null ? rawRemove.call(localStorage, k) : rawSet.call(localStorage, k, v); } catch (e) {} };
  const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch (e) { return d; } };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let meta = parse(lsGet(META_KEY), null); // {token, v, base, lastSync}
  const saveMeta = () => lsSet(META_KEY, meta ? JSON.stringify(meta) : null);
  let latest = { locs: {}, gps: [] }, seenGps = new Set(parse(lsGet('openusGpsSeen'), [])), applying = false;

  // ---------- API ----------
  async function api(path, body) {
    const r = await fetch('/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(meta?.token ? { authorization: 'Bearer ' + meta.token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (r.status === 401 && meta) { meta = null; saveMeta(); renderCards(); }
    if (!r.ok) throw new Error(j.error || 'Could not reach OpenUS sync');
    return j;
  }
  const say = (m) => { try { (cfg.toast || alert)(m); } catch (e) {} };

  // ---------- snapshot / apply ----------
  const localOnly = (k) => (cfg.localFields && cfg.localFields[k]) || [];
  function strip(k, s) {
    const f = localOnly(k); if (!f.length || s == null) return s;
    const o = parse(s, null); if (!o || typeof o !== 'object') return s;
    f.forEach((x) => delete o[x]); return JSON.stringify(o);
  }
  function snapshot() {
    const gps = parse(lsGet(GPS_KEY), {}) || {};
    try { gps.alerts = cfg.alertsOn ? !!cfg.alertsOn() : true; } catch (e) {}
    lsSet(GPS_KEY, JSON.stringify(gps));
    const doc = {}; KEYS.forEach((k) => { doc[k] = strip(k, lsGet(k)); }); return doc;
  }
  function writeDoc(doc) {
    applying = true;
    KEYS.forEach((k) => {
      if (!(k in doc)) return;
      let v = doc[k];
      const f = localOnly(k);
      if (v != null && f.length) { const mine = parse(lsGet(k), {}) || {}; const o = parse(v, {}); f.forEach((x) => { if (x in mine) o[x] = mine[x]; }); v = JSON.stringify(o); }
      lsSet(k, v);
    });
    applying = false;
    try { cfg.apply(); } catch (e) { console.error(e); }
    renderCards();
  }

  // ---------- 3-way merge ----------
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  function merge3(b, l, r) {
    if (eq(l, b)) return r; if (eq(r, b)) return l; if (eq(l, r)) return l;
    if (isObj(l) && isObj(r)) {
      const out = {}, bb = isObj(b) ? b : {};
      new Set([...Object.keys(l), ...Object.keys(r)]).forEach((k) => {
        const v = merge3(bb[k], l[k], r[k]); if (v !== undefined) out[k] = v;
      });
      return out;
    }
    if (Array.isArray(l) && Array.isArray(r)) {
      const B = Array.isArray(b) ? b : [];
      const withId = [...l, ...r].every((x) => isObj(x) && x.id != null);
      const key = (x) => (withId ? 'id:' + x.id : JSON.stringify(x));
      const bk = new Map(B.map((x) => [key(x), x])), lk = new Map(l.map((x) => [key(x), x])), rk = new Map(r.map((x) => [key(x), x]));
      const out = [];
      r.forEach((x) => { const k = key(x); if (bk.has(k) && !lk.has(k)) return; out.push(lk.has(k) ? merge3(bk.get(k), lk.get(k), x) : x); });
      l.forEach((x, i) => { const k = key(x); if (rk.has(k) || bk.has(k)) return; i < l.length / 2 ? out.unshift(x) : out.push(x); });
      return out;
    }
    return l;
  }
  function mergeDocs(base, local, remote) {
    const out = {};
    KEYS.forEach((k) => {
      const b = parse(base?.[k], null), l = parse(local[k], null), r = parse(remote[k], null);
      const m = merge3(b, l, r);
      out[k] = m == null ? (remote[k] ?? local[k] ?? null) : JSON.stringify(m);
    });
    return out;
  }

  // ---------- sync loop ----------
  let pushTimer = null, busy = false;
  function schedulePush() { if (!meta || applying) return; clearTimeout(pushTimer); pushTimer = setTimeout(push, 600); }
  async function push() {
    if (!meta || busy) { if (meta) schedulePush(); return; }
    busy = true;
    try {
      for (let i = 0; i < 4; i++) {
        const doc = snapshot();
        if (eq(doc, meta.base)) break;
        const r = await api('/sync/push', { v: meta.v, doc });
        if (r.ok) { meta.v = r.v; meta.base = doc; meta.lastSync = Date.now(); saveMeta(); break; }
        if (r.conflict) { const merged = mergeDocs(meta.base, doc, r.doc); meta.v = r.v; meta.base = r.doc; saveMeta(); writeDoc(merged); onRemote(r); }
      }
      setOffline(false);
    } catch (e) { setOffline(true); } finally { busy = false; renderCards(); }
  }
  async function pull() {
    if (!meta || busy || document.hidden) return;
    busy = true;
    try {
      const r = await api('/sync');
      if (r.v !== meta.v) {
        const local = snapshot();
        const merged = eq(local, meta.base) ? r.doc : mergeDocs(meta.base, local, r.doc);
        meta.v = r.v; meta.base = r.doc; saveMeta();
        writeDoc(merged);
        if (!eq(merged, r.doc)) schedulePush();
      }
      meta.lastSync = Date.now(); saveMeta();
      onRemote(r); setOffline(false);
    } catch (e) { setOffline(true); } finally { busy = false; }
  }
  function onRemote(r) {
    latest = { locs: r.locs || {}, gps: r.gps || [], code: r.code };
    const mine = me().role;
    let fresh = false;
    for (const g of latest.gps) {
      if (seenGps.has(g.id)) continue;
      seenGps.add(g.id); fresh = true;
      if (g.role !== mine && Date.now() - g.ts < 10 * 60e3) {
        const msg = `${g.name} ${g.arrived ? 'arrived at' : 'left'} ${g.place}`;
        say('📍 ' + msg);
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') navigator.serviceWorker?.ready.then((reg) => reg.showNotification(msg, { body: 'OpenUS live location', icon: 'icon-192.png', tag: 'gps' })).catch(() => {});
      }
    }
    if (fresh) lsSet('openusGpsSeen', JSON.stringify([...seenGps].slice(-300)));
    renderCards();
  }
  let offline = false;
  function setOffline(v) { if (v !== offline) { offline = v; renderCards(); } }

  // watch the app's own saves
  Storage.prototype.setItem = function (k, v) { rawSet.call(this, k, v); if (this === localStorage && KEYS.includes(k)) schedulePush(); };
  Storage.prototype.removeItem = function (k) {
    rawRemove.call(this, k);
    // "Start over" on one phone must never wipe the partner's phone: this phone just stops syncing.
    if (this === localStorage && cfg.keys.includes(k) && meta && !applying) { const t = meta.token; meta = null; saveMeta(); fetch('/api/sync/leave', { method: 'POST', headers: { authorization: 'Bearer ' + t } }).catch(() => {}); stopGps(); setTimeout(renderCards, 50); }
  };

  async function createSync() {
    try { const r = await api('/sync/create', { doc: snapshot() }); meta = { token: r.token, v: r.v, base: r.doc, lastSync: Date.now() }; saveMeta(); onRemote(r); say('Sync code ready: ' + r.code); }
    catch (e) { say(e.message); }
  }
  async function joinSync(inputId) {
    const el = document.getElementById(typeof inputId === 'string' ? inputId : 'osJoinCode'); const code = (el?.value || '').trim();
    if (code.length < 6) { say('Enter the 6-character code from the other phone'); return; }
    try {
      const r = await api('/sync/join', { code });
      meta = { token: r.token, v: r.v, base: r.doc, lastSync: Date.now() }; saveMeta();
      writeDoc(r.doc); onRemote(r);
      say('Phones synced 🎉 Now pick who you are on this phone.');
      try { cfg.afterJoin && cfg.afterJoin(); } catch (e) {}
    } catch (e) { say(e.message); }
  }
  async function newCode() { try { const r = await api('/sync/code', {}); latest.code = r.code; renderCards(); } catch (e) { say(e.message); } }
  function stopSync() { if (!meta) return; const t = meta.token; meta = null; saveMeta(); stopGps(); fetch('/api/sync/leave', { method: 'POST', headers: { authorization: 'Bearer ' + t } }).catch(() => {}); renderCards(); say('This phone stopped syncing. Your data stays on it.'); }
  async function shareCode(code) {
    const text = `Sync OpenUS with me: open ${location.origin}${location.pathname} on your phone, go to Your connection, and enter code ${code}`;
    try { if (navigator.share) { await navigator.share({ title: 'OpenUS sync code', text }); return; } } catch (e) { if (e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); say('Copied. Paste it in a text to your partner.'); } catch (e) { say('Your code: ' + code); }
  }

  // ---------- live GPS ----------
  const me = () => { try { return cfg.me() || {}; } catch (e) { return {}; } };
  const sharing = () => { try { return !!cfg.sharing(); } catch (e) { return false; } };
  let watchId = null, myPos = null, lastSent = 0, lastSentPos = null, wasSharing = false;
  const dist = (a, b) => { const R = 6371000, t = Math.PI / 180, x = Math.sin((b.lat - a.lat) * t / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin((b.lng - a.lng) * t / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
  function startGps() { if (watchId !== null || !navigator.geolocation || document.hidden) return; watchId = navigator.geolocation.watchPosition(onPos, (e) => { if (e.code === 1) { say('Location is blocked for OpenUS. Allow it in your phone settings to share live.'); stopGps(); } }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 }); }
  function stopGps() { if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }
  async function onPos(p) {
    myPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), ts: Date.now() };
    const moved = lastSentPos ? dist(lastSentPos, myPos) : 1e9, since = Date.now() - lastSent;
    if ((since < 20000 && moved < 40) || (since < 90000 && moved < 25)) return;
    lastSent = Date.now(); lastSentPos = myPos;
    await sendPos(true);
  }
  async function sendPos(on) {
    if (!meta) return;
    const m = me(); if (!m.role) return;
    try {
      const r = await api('/sync/location', { role: m.role, name: m.name || m.role, sharing: on, ...(on && myPos ? { lat: myPos.lat, lng: myPos.lng, acc: myPos.acc } : {}) });
      for (const t of r.transitions || []) {
        const ev = `${t.arrived ? 'Arrived at' : 'Left'} ${t.place}`;
        say(`📍 You ${t.arrived ? 'arrived at' : 'left'} ${t.place}`);
        try { cfg.onMove && cfg.onMove(m.name || m.role, ev, t.place); } catch (e) {}
      }
    } catch (e) {}
    renderCards();
  }
  function gpsTick() {
    const on = !!meta && sharing() && !document.hidden;
    if (on) startGps(); else stopGps();
    if (meta && wasSharing && !sharing()) sendPos(false);
    wasSharing = !!meta && sharing();
  }
  function pinPlace() {
    const sel = document.getElementById('osPinPlace'); const name = sel?.value;
    if (!name) { say('Add a safe place first'); return; }
    if (!navigator.geolocation) { say('This phone cannot share location'); return; }
    say('Finding your spot…');
    const got = (p) => {
      const g = parse(lsGet(GPS_KEY), {}) || {}; g.places = g.places || {};
      let radius = 300; try { radius = +cfg.radius() || 300; } catch (e) {}
      g.places[name] = { lat: p.coords.latitude, lng: p.coords.longitude, radius, acc: Math.round(p.coords.accuracy), ts: Date.now() };
      localStorage.setItem(GPS_KEY, JSON.stringify(g));
      say(p.coords.accuracy > 150 ? `${name} pinned, but only accurate to ${Math.round(p.coords.accuracy)} m. Pin again outdoors for better alerts.` : `${name} pinned to this spot (${radius} m alert radius)`);
      renderCards();
    };
    if (myPos && Date.now() - myPos.ts < 60000) { got({ coords: { latitude: myPos.lat, longitude: myPos.lng, accuracy: myPos.acc } }); return; }
    navigator.geolocation.getCurrentPosition(got, (e) => say(e.code === 1 ? 'Location is blocked. Allow it for OpenUS in your phone settings.' : 'Could not get your location. Try again.'), { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  }
  function unpin(name) { const g = parse(lsGet(GPS_KEY), {}) || {}; if (g.places) delete g.places[name]; localStorage.setItem(GPS_KEY, JSON.stringify(g)); renderCards(); }

  // ---------- notifications ----------
  let vapid = null;
  fetch('/api/config').then((r) => r.json()).then((j) => { vapid = j.vapidPublicKey; renderCards(); resub(); }).catch(() => {});
  function tellSW() { const m = me(); navigator.serviceWorker?.ready.then((reg) => reg.active?.postMessage({ type: 'sync', token: meta?.token || null, role: m.role || '' })).catch(() => {}); }
  async function enablePush() {
    try {
      if (!('Notification' in window) || !('PushManager' in window)) { say(/iphone|ipad/i.test(navigator.userAgent) ? 'On iPhone, add OpenUS to your home screen first, then open it from there.' : 'This browser does not support notifications'); return; }
      const perm = await Notification.requestPermission(); if (perm !== 'granted') { renderCards(); return; }
      if (!vapid) { say('Notifications are not set up on the server yet'); return; }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) { const raw = atob(vapid.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - vapid.length % 4) % 4)); sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) }); }
      await api('/push/subscribe', { subscription: sub.toJSON(), role: me().role || '' }); tellSW();
      say('Arrive / leave notifications are on for this phone');
    } catch (e) { say('Could not turn on notifications: ' + e.message); }
    renderCards();
  }
  async function resub() { try { if (!meta || !vapid || Notification.permission !== 'granted') return; const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) await api('/push/subscribe', { subscription: sub.toJSON(), role: me().role || '' }); tellSW(); } catch (e) {} }

  // ---------- cards (use the app's own styles) ----------
  const ago = (ts) => { const s = (Date.now() - ts) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(ts).toLocaleDateString(); };
  function slot(screenId, id) {
    const sec = document.getElementById(screenId); if (!sec) return null;
    let el = document.getElementById(id);
    if (!el) { el = document.createElement('div'); el.id = id; sec.appendChild(el); }
    return el;
  }
  const typing = (el) => { const a = document.activeElement; return !!(el && a && el.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)); };
  function renderCards() {
    const s = slot(cfg.syncScreen || 'invite', 'osSyncCard');
    if (s) {
      if (!meta) {
        s.innerHTML = `<div class="card"><h3>Sync two phones</h3><p class="muted">Use OpenUS on both phones and keep everything in step, including boundaries, check-ins, contacts, safe places and live location.</p>
          <button class="btn" id="osCreate">Create sync code</button>
          <p class="muted" style="margin-top:12px">Got a code from the other phone?</p>
          <div class="row nowrap"><input id="osJoinCode" maxlength="6" placeholder="ABC123" autocomplete="off" autocapitalize="characters" style="text-transform:uppercase;letter-spacing:.2em;text-align:center;font-weight:800"><button class="btn small" id="osJoin">Join</button></div>
          <p class="muted">Joining copies the other phone's OpenUS onto this one.</p></div>`;
        s.querySelector('#osCreate').onclick = createSync; s.querySelector('#osJoin').onclick = () => joinSync('osJoinCode');
      } else {
        const code = latest.code;
        s.innerHTML = `<div class="card"><h3>✓ Phones synced</h3><div class="muted">${offline ? 'Offline. Changes will send when you reconnect.' : 'Last synced ' + ago(meta.lastSync || Date.now())}</div>
          ${code ? `<p class="muted" style="margin-top:10px">Code for the other phone</p><div style="font-size:30px;font-weight:900;letter-spacing:.18em;text-align:center;padding:10px;border:1px dashed var(--blue,#08a8ff);border-radius:14px">${esc(code)}</div><button class="btn small" id="osShare">Send code</button> ` : ''}
          <button class="btn small secondary" id="osNew">New code</button> <button class="btn small secondary" id="osStop">Stop syncing on this phone</button></div>`;
        s.querySelector('#osStop').onclick = stopSync; s.querySelector('#osNew').onclick = newCode;
        const sh = s.querySelector('#osShare'); if (sh) sh.onclick = () => shareCode(code);
      }
    }
    const w = cfg.joinScreen && slot(cfg.joinScreen, 'osJoinCard');
    if (w && !typing(w)) {
      w.innerHTML = meta ? '' : `<div class="card"><b>Partner already set up OpenUS?</b><p class="muted">Enter the sync code from their phone (in <b>Your connection</b>) to use the same OpenUS on this phone.</p>
        <div class="row nowrap"><input id="osJoinCode2" maxlength="6" placeholder="ABC123" autocomplete="off" autocapitalize="characters" style="text-transform:uppercase;letter-spacing:.2em;text-align:center;font-weight:800"><button class="btn small" id="osJoin2">Join</button></div></div>`;
      const j2 = w.querySelector('#osJoin2'); if (j2) j2.onclick = () => joinSync('osJoinCode2');
    }
    const g = slot(cfg.gpsScreen || 'location', 'osGpsCard');
    if (g && !typing(g)) {
      const m = me(), gps = parse(lsGet(GPS_KEY), {}) || {}, pins = gps.places || {};
      let places = []; try { places = cfg.places() || []; } catch (e) {}
      const others = Object.entries(latest.locs || {}).filter(([role]) => role !== m.role);
      const near = (l) => { const ps = Object.entries(pins).map(([n, p]) => [n, dist(l, p), p.radius]).sort((a, b) => a[1] - b[1]); if (!ps.length) return ''; const [n, d, r] = ps[0]; return d <= r ? ` · at ${esc(n)}` : ` · ${d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km'} from ${esc(n)}`; };
      const pushState = !('Notification' in window) ? 'unsupported' : Notification.permission;
      g.innerHTML = `<h3>Live GPS</h3><div class="card">
        ${!meta ? `<p class="muted">Sync with your partner's phone first (in <b>Your connection</b>) to share live location.</p>` :
          `<div class="muted">${sharing() ? (watchId !== null ? '● Sharing your live location while OpenUS is open' : 'Sharing is on. Live updates start when OpenUS is open.') : 'Turn on <b>Share my location</b> above to share live.'}</div>
           ${others.length ? others.map(([role, l]) => `<div class="setting"><div><b>${esc(l.name || role)}</b><div class="muted">${ago(l.ts)}${near(l)}${l.acc ? ' · ±' + l.acc + ' m' : ''}</div></div><a class="btn small secondary" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lng}">Open map</a></div>`).join('') : `<p class="muted">Your partner isn't sharing live location right now.</p>`}`}
        <h3 style="margin-top:14px">Pin safe places</h3><p class="muted">Stand at the place and pin it. You'll each get a notification when the other arrives or leaves.</p>
        ${Object.keys(pins).length ? `<div class="row">${Object.entries(pins).map(([n, p]) => `<span class="pill">📍 ${esc(n)} · ${p.radius} m <button data-unpin="${esc(n)}" aria-label="Unpin ${esc(n)}">×</button></span>`).join('')}</div>` : ''}
        <div class="row nowrap"><select id="osPinPlace" aria-label="Safe place">${places.map((p) => `<option>${esc(p)}</option>`).join('')}</select><button class="btn small" id="osPin">Pin here</button></div>
        <div class="setting"><div><b>Notifications on this phone</b><div class="muted">${pushState === 'granted' ? 'On' : pushState === 'denied' ? 'Blocked in your phone settings' : pushState === 'unsupported' ? (/iphone|ipad/i.test(navigator.userAgent) ? 'On iPhone: Add to Home Screen first' : 'Not supported here') : 'Off'}</div></div>${pushState === 'default' ? '<button class="btn small" id="osPush">Turn on</button>' : ''}</div>
        <p class="muted">Phones pause web apps in the background, so live location updates while OpenUS is open.</p></div>`;
      const pin = g.querySelector('#osPin'); if (pin) pin.onclick = pinPlace;
      const pb = g.querySelector('#osPush'); if (pb) pb.onclick = enablePush;
      g.querySelectorAll('[data-unpin]').forEach((b) => (b.onclick = () => unpin(b.dataset.unpin)));
    }
  }

  // ---------- start ----------
  setInterval(() => { if (!document.hidden) pull(); gpsTick(); }, 4000);
  document.addEventListener('visibilitychange', () => { gpsTick(); if (!document.hidden) { pull(); resub(); } });
  addEventListener('online', () => { pull(); schedulePush(); });
  setInterval(() => { const cur = document.getElementById('osGpsCard'); renderCards(); }, 30000);
  renderCards(); tellSW(); gpsTick();
  if (meta) { pull(); schedulePush(); }
  window.OpenUSSync = { createSync, joinSync, stopSync, push, pull, merge3 };
})();
