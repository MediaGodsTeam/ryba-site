/* Демо-режим для GitHub Pages: сервера нет, поэтому запросы к api/ обрабатываются прямо в браузере
   по тем же правилам, что и в server.js. Данные хранятся в localStorage этого браузера.
   Включается сам на *.github.io или по адресу с ?demo. На настоящем сервере ничего не делает. */
(function () {
  "use strict";
  const on = /\.github\.io$/.test(location.hostname) || /[?&]demo\b/.test(location.search) || sessionStorage.getItem("ryba-demo") === "1";
  if (!on) return;
  try { sessionStorage.setItem("ryba-demo", "1"); } catch {}
  window.DEMO = true;
  const KEY = "ryba-demo-v1", TZ = 3 * 3600e3, PASSWORD = "demo";
  const realFetch = window.fetch.bind(window);
  let CONFIG, PRODUCTS, ROUTES, POINTS, SLOT_MIN, DB;
  const ready = realFetch("config.json", { cache: "no-cache" }).then((r) => r.json()).then((c) => {
    CONFIG = c; SLOT_MIN = Number(c.slotMinutes) || 0;
    PRODUCTS = Object.fromEntries(c.products.map((p) => [p.id, p]));
    ROUTES = Object.fromEntries(c.routes.map((r) => [r.id, r]));
    POINTS = {};
    c.routes.forEach((r) => r.points.forEach((p, i) => { POINTS[`${r.id}-${i + 1}`] = { id: `${r.id}-${i + 1}`, n: i + 1, name: p[0], addr: p[1], from: p[2], to: p[3], route: r }; }));
    try { DB = JSON.parse(localStorage.getItem(KEY)); } catch {}
    if (!DB || !DB.orders) DB = seed();
  });
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch {} };

  // ---- время ----
  function weekendStart() { const m = new Date(Date.now() + TZ), d = m.getUTCDay(), add = d === 6 ? 0 : d === 0 ? -1 : 6 - d; return Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() + add); }
  const wkKey = (ms) => new Date(ms).toISOString().slice(0, 10);
  const weekendKey = () => wkKey(weekendStart());
  const hm = (s) => { const [h, m] = String(s).split(":").map(Number); return (h * 60 + m) * 60e3; };
  const fmtHM = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
  const at = (route, t) => weekendStart() + route.off * 864e5 + hm(t) - TZ;
  const routeDeadline = (r) => { const d = r.deadline || { daysBeforeSaturday: 1, time: "21:00" }; return weekendStart() + hm(d.time) - (Number(d.daysBeforeSaturday) || 0) * 864e5 - TZ; };
  const deadlines = () => Object.fromEntries(CONFIG.routes.map((r) => [r.id, routeDeadline(r)]));
  function slotsOf(p) { if (!SLOT_MIN) return []; const a = hm(p.from) / 60e3, b = hm(p.to) / 60e3, out = []; for (let s = a; s < b; s += SLOT_MIN) out.push(`${fmtHM(s)}–${fmtHM(Math.min(s + SLOT_MIN, b))}`); return out; }
  const allSlots = () => Object.fromEntries(Object.values(POINTS).map((p) => [p.id, slotsOf(p)]));

  // ---- машина, склад, деньги ----
  const EMPTY = () => ({ delay: 0, at: null, arrivedAt: null, departed: {} });
  function truck(wk, rid) { DB.state.truck[wk] = DB.state.truck[wk] || {}; return (DB.state.truck[wk][rid] = DB.state.truck[wk][rid] || EMPTY()); }
  const truckView = (wk) => Object.fromEntries(CONFIG.routes.map((r) => { const t = (DB.state.truck[wk] || {})[r.id] || EMPTY(); return [r.id, { delay: t.delay || 0, at: t.at, arrivedAt: t.arrivedAt, departed: Object.keys(t.departed || {}) }]; }));
  function pointClosed(p, wk = weekendKey()) { const t = (DB.state.truck[wk] || {})[p.route.id]; if (t && t.departed && t.departed[p.id]) return true; if (wk !== weekendKey()) return true; return Date.now() > at(p.route, p.to) + ((t && t.delay) || 0) * 60e3; }
  const active = (wk) => DB.orders.filter((o) => o.weekend === wk && !o.cancelled);
  const stockOf = (wk, rid) => Object.assign({}, ((DB.state.stock[wk] || {})[rid]) || ROUTES[rid].stock || {});
  function remainingOf(wk, rid) { const s = stockOf(wk, rid), o = {}; active(wk).filter((x) => x.route === rid).forEach((x) => Object.entries(x.items).forEach(([k, q]) => (o[k] = (o[k] || 0) + q))); return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Math.max(0, v - (o[k] || 0))])); }
  function amountOf(o, w) { let s = 0; for (const [k, q] of Object.entries(o.items)) { const p = PRODUCTS[k]; if (!p) continue; if (p.per === "kg") { const x = Number(w && w[k]); if (!(x > 0)) return null; s += x * p.price; } else s += q * p.price; } return Math.round(s); }
  const nameKey = (o) => `${o.first} ${o.last}`.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  function noShows(before) { const m = {}; DB.orders.forEach((o) => { if (o.weekend < before && !o.issued && !o.cancelled) { const k = nameKey(o); m[k] = (m[k] || 0) + 1; } }); return m; }
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "d" + Math.random().toString(16).slice(2) + Date.now().toString(16));
  function makeCode(p, wk) { const used = new Set(DB.orders.filter((o) => o.weekend === wk).map((o) => o.code)); let c; do c = `${p.route.letter}${p.n}-${100 + Math.floor(Math.random() * 900)}`; while (used.has(c)); return c; }
  const strip = (o, keepWeights) => { const c = Object.assign({}, o); delete c.token; if (!keepWeights) delete c.weights; return c; };

  // ---- демо-данные ----
  function seed() {
    const db = { orders: [], state: { truck: {}, stock: {} }, admin: false };
    const first = ["Анна", "Иван", "Мария", "Сергей", "Елена", "Дмитрий", "Ольга", "Алексей", "Наталья", "Павел", "Татьяна", "Андрей", "Ирина", "Виктор", "Светлана", "Николай"];
    const last = ["Петров", "Иванова", "Смирнов", "Кузнецова", "Попов", "Соколова", "Лебедев", "Козлова", "Новиков", "Морозова", "Волков", "Павлова", "Фёдоров", "Орлова"];
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    const pts = Object.values(POINTS), weight = (p) => (p.route.id === "sat" ? 1.4 : p.route.id === "sun" ? 1 : 0.7) * (p.n <= 4 ? 1.5 : 1);
    const pickPoint = () => { const tot = pts.reduce((a, p) => a + weight(p), 0); let r = Math.random() * tot; for (const p of pts) { r -= weight(p); if (r <= 0) return p; } return pts[0]; };
    const items = () => { const it = { trout: 1 + Math.floor(Math.random() * 3) }; if (Math.random() < 0.35) it.steak = 1; if (Math.random() < 0.25) it.fillet = 1; if (Math.random() < 0.3) it[pick(["uha", "rolls", "tomyam", "liver", "pasta", "kimchi"])] = 1; return it; };
    const cur = weekendStart();
    for (let k = 4; k >= 1; k--) {
      const wk = wkKey(cur - k * 7 * 864e5), n = 26 + Math.floor(Math.random() * 14);
      for (let i = 0; i < n; i++) {
        const p = pickPoint(), it = items(), cancelled = Math.random() < 0.05, issued = !cancelled && Math.random() < 0.88;
        const o = { id: uuid(), weekend: wk, route: p.route.id, point: p.id, slot: pick(slotsOf(p)) || null, items: it, units: Object.values(it).reduce((a, x) => a + x, 0), first: pick(first), last: pick(last), code: `${p.route.letter}${p.n}-${100 + i}`, createdAt: cur - k * 7 * 864e5 - 2 * 864e5, issued, cancelled, token: "x" };
        if (issued) { o.weights = {}; Object.keys(it).forEach((x) => { if (PRODUCTS[x] && PRODUCTS[x].per === "kg") o.weights[x] = Math.round(it[x] * (PRODUCTS[x].approxKg || 0.8) * (0.85 + Math.random() * 0.3) * 100) / 100; }); o.amount = amountOf(o, o.weights); }
        db.orders.push(o);
      }
    }
    [3, 1].forEach((k) => db.orders.push({ id: uuid(), weekend: wkKey(cur - k * 7 * 864e5), route: "sat", point: "sat-3", slot: null, items: { trout: 1 }, units: 1, first: "Олег", last: "Сидоров", code: "С3-777", createdAt: cur - k * 7 * 864e5, issued: false, cancelled: false, token: "x" }));
    const wk = wkKey(cur);
    db.state.stock[wk] = { sat: { trout: 60, steak: 15, fillet: 12 }, sun: { trout: 50, steak: 12 }, sub: { trout: 30 } };
    DB = db;
    for (let i = 0; i < 26; i++) {
      const p = pickPoint(); if (pointClosed(p)) continue; const it = items();
      const rem = remainingOf(wk, p.route.id); if (Object.entries(it).some(([k, q]) => k in rem && q > rem[k])) continue;
      db.orders.push({ id: uuid(), weekend: wk, route: p.route.id, point: p.id, slot: pick(slotsOf(p)) || null, items: it, units: Object.values(it).reduce((a, x) => a + x, 0), first: pick(first), last: pick(last), code: makeCode(p, wk), createdAt: Date.now() - Math.floor(Math.random() * 2 * 864e5), issued: false, cancelled: false, token: "x" });
    }
    db.orders.push({ id: uuid(), weekend: wk, route: "sat", point: "sat-3", slot: slotsOf(POINTS["sat-3"])[0] || null, items: { trout: 1, liver: 2 }, units: 3, first: "Олег", last: "Сидоров", code: makeCode(POINTS["sat-3"], wk), createdAt: Date.now() - 3600e3, issued: false, cancelled: false, token: "x" });
    localStorage.setItem(KEY, JSON.stringify(db));
    return db;
  }

  // ---- обработчик запросов ----
  const json = (code, body, extra) => new Response(JSON.stringify(body), { status: code, headers: Object.assign({ "Content-Type": "application/json" }, extra || {}) });
  async function handle(url, init) {
    await ready;
    const method = (init && init.method) || "GET", p = url.pathname.replace(/^.*\/api\//, "/api/");
    let b = {}; try { b = init && init.body ? JSON.parse(init.body) : {}; } catch {}
    const wkParam = url.searchParams.get("weekend") || weekendKey();
    if (p === "/api/config") return json(200, { title: CONFIG.title, city: CONFIG.city, notes: CONFIG.notes, maxPerItem: CONFIG.maxPerItem, slotMinutes: SLOT_MIN, products: CONFIG.products, routes: CONFIG.routes.map((r) => { const c = Object.assign({}, r); delete c.stock; return c; }), weekend: weekendKey(), now: Date.now(), slots: allSlots() });
    if (p === "/api/load") {
      const wk = weekendKey(), by = {};
      active(wk).forEach((o) => { const s = (by[o.point] = by[o.point] || { orders: 0, units: 0, trout: 0, slots: {} }); s.orders++; s.units += o.units; s.trout += o.items.trout || 0; if (o.slot) s.slots[o.slot] = (s.slots[o.slot] || 0) + 1; });
      return json(200, { weekend: wk, points: by, closed: Object.values(POINTS).filter((x) => pointClosed(x)).map((x) => x.id), deadlines: deadlines(), truck: truckView(wk), remaining: Object.fromEntries(CONFIG.routes.map((r) => [r.id, remainingOf(wk, r.id)])), now: Date.now() });
    }
    if (p === "/api/orders" && method === "POST") {
      const pt = POINTS[b.point];
      if (!pt) return json(400, { error: "Выберите точку из списка." });
      if (Date.now() > routeDeadline(pt.route)) return json(400, { error: `Приём заказов на ${pt.route.day.toLowerCase()} (${pt.route.sub}) уже закрыт.` });
      if (pointClosed(pt)) return json(400, { error: "Машина уже уехала с этой точки. Выберите другую." });
      const slots = slotsOf(pt); if (slots.length && !slots.includes(b.slot)) return json(400, { error: "Выберите время, когда подойдёте." });
      const items = {}; Object.entries(b.items || {}).forEach(([k, v]) => { const q = Math.floor(Number(v)); if (PRODUCTS[k] && q > 0) items[k] = Math.min(q, CONFIG.maxPerItem); });
      if (!Object.keys(items).length) return json(400, { error: "Добавьте хотя бы один товар." });
      const first = String(b.first || "").trim().slice(0, 40), last = String(b.last || "").trim().slice(0, 40);
      if (!first || !last) return json(400, { error: "Укажите имя и фамилию." });
      const wk = weekendKey(), rem = remainingOf(wk, pt.route.id);
      for (const [k, q] of Object.entries(items)) if (k in rem && q > rem[k]) return json(409, { error: rem[k] ? `${PRODUCTS[k].n}: осталось только ${rem[k]} ${PRODUCTS[k].u}. Уменьшите количество.` : `${PRODUCTS[k].n} на этот рейс закончилось. Уберите из заказа.`, remaining: rem });
      const o = { id: uuid(), weekend: wk, route: pt.route.id, point: pt.id, slot: slots.length ? b.slot : null, items, units: Object.values(items).reduce((a, x) => a + x, 0), first, last, code: makeCode(pt, wk), createdAt: Date.now(), issued: false, cancelled: false, token: uuid() };
      DB.orders.push(o); save(); return json(201, Object.assign(strip(o), { token: o.token }));
    }
    let m = p.match(/^\/api\/orders\/([\w-]+)\/(cancel|status)$/);
    if (m) {
      const o = DB.orders.find((x) => x.id === m[1]); if (!o || o.token !== b.token) return json(404, { error: "Заказ не найден." });
      if (m[2] === "status" || o.cancelled) return json(200, strip(o));
      if (o.issued) return json(400, { error: "Заказ уже выдан." });
      const pt = POINTS[o.point]; if (o.weekend !== weekendKey() || Date.now() > at(pt.route, pt.from)) return json(400, { error: "Отменить через сайт уже нельзя: машина на точке или уехала." });
      o.cancelled = true; o.cancelledAt = Date.now(); save(); return json(200, strip(o));
    }
    if (p === "/api/admin/login") { if (String(b.password || "") !== PASSWORD) return json(401, { error: "Неверный пароль. В демо-версии пароль: demo" }); DB.admin = true; save(); return json(200, { ok: true }); }
    if (p === "/api/admin/logout") { DB.admin = false; save(); return json(200, { ok: true }); }
    if (!p.startsWith("/api/admin/")) return json(404, { error: "Не найдено." });
    if (!DB.admin) return json(401, { error: "Нужно войти." });
    if (p === "/api/admin/orders") {
      const weekends = [...new Set(DB.orders.map((o) => o.weekend))].sort().reverse();
      return json(200, { weekend: wkParam, current: weekendKey(), weekends, orders: DB.orders.filter((o) => o.weekend === wkParam).map((o) => strip(o, true)), stock: Object.fromEntries(CONFIG.routes.map((r) => [r.id, stockOf(wkParam, r.id)])), truck: truckView(wkParam), closed: Object.values(POINTS).filter((x) => pointClosed(x, wkParam)).map((x) => x.id), noShows: noShows(wkParam), slots: allSlots() });
    }
    if (p === "/api/admin/stats") {
      const cur = weekendKey(), weeks = {};
      DB.orders.forEach((o) => { const w = (weeks[o.weekend] = weeks[o.weekend] || { weekend: o.weekend, orders: 0, cancelled: 0, issued: 0, noShow: 0, revenue: 0, trout: 0, points: {} }); if (o.cancelled) { w.cancelled++; return; } w.orders++; w.trout += o.items.trout || 0; w.points[o.point] = (w.points[o.point] || 0) + 1; if (o.issued) { w.issued++; w.revenue += o.amount || 0; } else if (o.weekend < cur) w.noShow++; });
      const repeat = Object.entries(noShows(cur)).filter(([, n]) => n >= 2).sort((a, c) => c[1] - a[1]).map(([name, n]) => ({ name, n }));
      return json(200, { current: cur, weeks: Object.values(weeks).sort((a, c) => (a.weekend < c.weekend ? 1 : -1)), repeatNoShows: repeat });
    }
    m = p.match(/^\/api\/admin\/orders\/([\w-]+)$/);
    if (m) {
      const o = DB.orders.find((x) => x.id === m[1]); if (!o) return json(404, { error: "Заказ не найден." });
      if (method === "GET") return json(200, strip(o, true));
      if (method === "DELETE") { DB.orders = DB.orders.filter((x) => x.id !== o.id); save(); return json(200, { ok: true }); }
      if (b.issued === true) { const w = {}; Object.entries(b.weights || {}).forEach(([k, v]) => { const n = Number(String(v).replace(",", ".")); if (PRODUCTS[k] && o.items[k] && n > 0 && n < 200) w[k] = Math.round(n * 1000) / 1000; }); Object.assign(o, { issued: true, cancelled: false, weights: w, amount: amountOf(o, w), issuedAt: Date.now() }); }
      else if (b.issued === false) { o.issued = false; delete o.weights; delete o.amount; delete o.issuedAt; }
      save(); return json(200, strip(o, true));
    }
    if (p === "/api/admin/stock") {
      if (!ROUTES[b.route]) return json(400, { error: "Неизвестный маршрут." });
      const s = {}; Object.entries(b.stock || {}).forEach(([k, v]) => { if (v === "" || v === null) return; const n = Math.floor(Number(v)); if (PRODUCTS[k] && n >= 0) s[k] = n; });
      DB.state.stock[wkParam] = DB.state.stock[wkParam] || {}; DB.state.stock[wkParam][b.route] = s; save();
      return json(200, { stock: s, remaining: remainingOf(wkParam, b.route) });
    }
    if (p === "/api/admin/truck") {
      if (!ROUTES[b.route]) return json(400, { error: "Неизвестный маршрут." });
      const t = truck(weekendKey(), b.route), pt = POINTS[b.point];
      if (b.action === "arrive" && pt) { t.at = pt.id; t.arrivedAt = Date.now(); delete t.departed[pt.id]; }
      else if (b.action === "depart" && pt) { t.departed[pt.id] = Date.now(); if (t.at === pt.id) { t.at = null; t.arrivedAt = null; } }
      else if (b.action === "undo" && pt) { delete t.departed[pt.id]; if (t.at === pt.id) { t.at = null; t.arrivedAt = null; } }
      else if (b.action === "delay") t.delay = Math.max(0, Math.min(240, Math.round(Number(b.delay) || 0)));
      else if (b.action === "reset") Object.assign(t, EMPTY());
      save(); return json(200, truckView(weekendKey()));
    }
    if (p === "/api/admin/export.csv") {
      const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const cols = ["Номер", "Имя", "Фамилия", "День", "Маршрут", "Точка", "Окно", ...CONFIG.products.map((x) => `${x.n}, ${x.u}`), "Всего позиций", "Статус", "Сумма, ₽"];
      const rows = DB.orders.filter((o) => o.weekend === wkParam).map((o) => { const pt = POINTS[o.point]; return [o.code, o.first, o.last, pt.route.day, pt.route.sub, pt.name, o.slot || `${pt.from}–${pt.to}`, ...CONFIG.products.map((x) => o.items[x.id] || ""), o.units, o.cancelled ? "отменён" : o.issued ? "выдан" : "ждёт", o.amount ?? ""].map(q).join(";"); });
      return new Response("﻿" + [cols.map(q).join(";"), ...rows].join("\r\n"), { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8" } });
    }
    return json(404, { error: "Не найдено." });
  }

  window.fetch = function (input, init) {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (url.origin === location.origin && /\/api\//.test(url.pathname)) return handle(url, init).catch((e) => json(500, { error: "Ошибка демо-режима: " + e.message }));
    return realFetch(input, init);
  };

  // ---- плашка демо-режима ----
  function banner() {
    const wrap = document.querySelector(".wrap"); if (!wrap) return;
    const isAdmin = /admin/.test(location.pathname);
    const el = document.createElement("div");
    el.className = "demo";
    el.innerHTML = `<div><b>Демо-версия.</b> Заказы и отметки хранятся только в этом браузере, никуда не отправляются. Для наглядности уже добавлены примерные заказы. ${isAdmin ? "Пароль: <b>demo</b>." : 'Страница выдачи: <a href="admin.html">admin.html</a>, пароль <b>demo</b>.'}</div><button class="btn sm" type="button" id="demoReset">Сбросить демо</button>`;
    wrap.insertBefore(el, wrap.firstChild);
    el.querySelector("#demoReset").addEventListener("click", (e) => {
      const b = e.currentTarget;
      if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Точно сбросить?"; return; }
      try { localStorage.removeItem(KEY); localStorage.removeItem("ryba-mine"); } catch {}
      location.reload();
    });
    const st = document.createElement("style");
    st.textContent = ".demo{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;background:var(--sea-soft);border:1px dashed var(--sea);border-radius:var(--r);padding:10px 14px;font-size:13px}.demo>div{flex:1;min-width:220px}.demo a{color:var(--sea);font-weight:700}.btn.sm{min-height:38px;padding:6px 14px;font-size:14px}";
    document.head.appendChild(st);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", banner); else banner();
})();
