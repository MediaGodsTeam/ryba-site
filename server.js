// Рыбный рейс — сервер заказов. Без внешних зависимостей: нужен только Node.js 18+.
// Запуск: ADMIN_PASSWORD=ваш_пароль node server.js
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SECRET_FILE = path.join(DATA_DIR, "secret.key");
const PUBLIC_DIR = path.join(ROOT, "public");
const TZ = 3 * 3600e3; // Москва / Краснодар, UTC+3

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
  console.error("Задайте пароль администратора не короче 8 символов: ADMIN_PASSWORD=... node server.js");
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const SLOT_MIN = Number(CONFIG.slotMinutes) || 0;
const PRODUCTS = Object.fromEntries(CONFIG.products.map((p) => [p.id, p]));
const ROUTES = Object.fromEntries(CONFIG.routes.map((r) => [r.id, r]));
const POINTS = {};
for (const r of CONFIG.routes) r.points.forEach((p, i) => {
  POINTS[`${r.id}-${i + 1}`] = { id: `${r.id}-${i + 1}`, n: i + 1, name: p[0], addr: p[1], from: p[2], to: p[3], route: r };
});

let SECRET;
try { SECRET = fs.readFileSync(SECRET_FILE); } catch { SECRET = crypto.randomBytes(32); fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 }); }

// ---------- хранилище ----------
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
let orders = readJson(ORDERS_FILE, []);
const state = readJson(STATE_FILE, {});
state.truck = state.truck || {}; state.stock = state.stock || {};
let writing = Promise.resolve();
function save(file, obj) {
  const snapshot = JSON.stringify(obj);
  writing = writing.then(() => new Promise((res) => {
    const tmp = file + ".tmp";
    fs.writeFile(tmp, snapshot, (e) => {
      if (e) { console.error("Ошибка записи", e); return res(); }
      fs.rename(tmp, file, (e2) => { if (e2) console.error("Ошибка записи", e2); res(); });
    });
  }));
  return writing;
}
const saveOrders = () => save(ORDERS_FILE, orders);
const saveState = () => save(STATE_FILE, state);

// ---------- время ----------
function weekendStart() {
  const m = new Date(Date.now() + TZ); const dow = m.getUTCDay();
  const add = dow === 6 ? 0 : dow === 0 ? -1 : 6 - dow;
  return Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() + add);
}
const weekendKey = () => new Date(weekendStart()).toISOString().slice(0, 10);
const hm = (s) => { const [h, m] = String(s).split(":").map(Number); return (h * 60 + m) * 60e3; };
const fmtHM = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
// «ЧЧ:ММ» в день маршрута текущих выходных → момент времени UTC
const at = (route, t) => weekendStart() + route.off * 864e5 + hm(t) - TZ;
function routeDeadline(r) {
  const d = r.deadline || { daysBeforeSaturday: 1, time: "21:00" };
  return weekendStart() + hm(d.time) - (Number(d.daysBeforeSaturday) || 0) * 864e5 - TZ;
}
const deadlines = () => Object.fromEntries(CONFIG.routes.map((r) => [r.id, routeDeadline(r)]));
function slotsOf(p) {
  if (!SLOT_MIN) return [];
  const a = hm(p.from) / 60e3, b = hm(p.to) / 60e3, out = [];
  for (let s = a; s < b; s += SLOT_MIN) out.push(`${fmtHM(s)}–${fmtHM(Math.min(s + SLOT_MIN, b))}`);
  return out;
}

// ---------- машина ----------
const EMPTY_TRUCK = () => ({ delay: 0, at: null, arrivedAt: null, departed: {} });
function truck(wk, rid) {
  state.truck[wk] = state.truck[wk] || {};
  return (state.truck[wk][rid] = state.truck[wk][rid] || EMPTY_TRUCK());
}
const truckView = (wk) => Object.fromEntries(CONFIG.routes.map((r) => {
  const t = (state.truck[wk] || {})[r.id] || EMPTY_TRUCK();
  return [r.id, { delay: t.delay || 0, at: t.at, arrivedAt: t.arrivedAt, departed: Object.keys(t.departed || {}) }];
}));
function pointClosed(p, wk = weekendKey()) {
  const t = (state.truck[wk] || {})[p.route.id];
  if (t && t.departed && t.departed[p.id]) return true;
  if (wk !== weekendKey()) return true;
  return Date.now() > at(p.route, p.to) + ((t && t.delay) || 0) * 60e3;
}

// ---------- склад ----------
const active = (wk) => orders.filter((o) => o.weekend === wk && !o.cancelled);
function stockOf(wk, rid) {
  const s = ((state.stock[wk] || {})[rid]) || ROUTES[rid].stock || {};
  return Object.fromEntries(Object.entries(s).filter(([k, v]) => PRODUCTS[k] && Number.isFinite(v) && v >= 0));
}
function orderedOf(wk, rid) {
  const t = {};
  for (const o of active(wk)) if (o.route === rid) for (const [k, q] of Object.entries(o.items)) t[k] = (t[k] || 0) + q;
  return t;
}
function remainingOf(wk, rid) {
  const s = stockOf(wk, rid), o = orderedOf(wk, rid);
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Math.max(0, v - (o[k] || 0))]));
}

// ---------- деньги ----------
function amountOf(o, weights) {
  let sum = 0;
  for (const [k, q] of Object.entries(o.items)) {
    const p = PRODUCTS[k]; if (!p) continue;
    if (p.per === "kg") { const w = Number(weights && weights[k]); if (!(w > 0)) return null; sum += w * p.price; }
    else sum += q * p.price;
  }
  return Math.round(sum);
}

// ---------- защита от спама ----------
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(key, arr); return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();
const clientIp = (req) => String(req.headers["x-real-ip"] || req.socket.remoteAddress || "");

// ---------- админ-сессия ----------
const sign = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("hex");
function makeToken() { const exp = Date.now() + 14 * 864e5; return `${exp}.${sign("adm." + exp)}`; }
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function isAdmin(req) {
  const c = Object.fromEntries((req.headers.cookie || "").split(";").map((s) => s.trim().split("=")));
  const [exp, sig] = String(c.adm || "").split(".");
  return !!exp && !!sig && Date.now() < Number(exp) && safeEq(sig, sign("adm." + exp));
}

// ---------- помощники ----------
function send(res, code, body, headers = {}) {
  const isStr = typeof body === "string";
  res.writeHead(code, Object.assign({
    "Content-Type": isStr ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  }, headers));
  res.end(isStr ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 20000) { reject(new Error("big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("json")); } });
    req.on("error", reject);
  });
}
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
const nameKey = (o) => `${o.first} ${o.last}`.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
function makeCode(p, wk) {
  const used = new Set(orders.filter((o) => o.weekend === wk).map((o) => o.code));
  for (let i = 0; i < 300; i++) { const c = `${p.route.letter}${p.n}-${100 + crypto.randomInt(900)}`; if (!used.has(c)) return c; }
  return `${p.route.letter}${p.n}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}
const forAdmin = (o) => { const { token, ...rest } = o; return rest; };
const forCustomer = (o) => { const { token, weights, ...rest } = o; return rest; };

// Неявки: заказы прошлых выходных, которые не выданы и не отменены.
function noShows(beforeWk) {
  const m = {};
  for (const o of orders) if (o.weekend < beforeWk && !o.issued && !o.cancelled) { const k = nameKey(o); m[k] = (m[k] || 0) + 1; }
  return m;
}

function loadSummary(wk) {
  const by = {};
  for (const o of active(wk)) {
    const s = (by[o.point] = by[o.point] || { orders: 0, units: 0, trout: 0, slots: {} });
    s.orders++; s.units += o.units; s.trout += o.items.trout || 0;
    if (o.slot) s.slots[o.slot] = (s.slots[o.slot] || 0) + 1;
  }
  return {
    weekend: wk, points: by, closed: Object.values(POINTS).filter((p) => pointClosed(p, wk)).map((p) => p.id),
    deadlines: deadlines(), truck: truckView(wk),
    remaining: Object.fromEntries(CONFIG.routes.map((r) => [r.id, remainingOf(wk, r.id)])),
    now: Date.now(),
  };
}

function statsAll() {
  const cur = weekendKey(), weeks = {};
  for (const o of orders) {
    const w = (weeks[o.weekend] = weeks[o.weekend] || { weekend: o.weekend, orders: 0, cancelled: 0, issued: 0, noShow: 0, revenue: 0, trout: 0, points: {} });
    if (o.cancelled) { w.cancelled++; continue; }
    w.orders++; w.trout += o.items.trout || 0; w.points[o.point] = (w.points[o.point] || 0) + 1;
    if (o.issued) { w.issued++; w.revenue += o.amount || 0; } else if (o.weekend < cur) w.noShow++;
  }
  const repeat = Object.entries(noShows(cur)).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
  return { current: cur, weeks: Object.values(weeks).sort((a, b) => (a.weekend < b.weekend ? 1 : -1)), repeatNoShows: repeat };
}

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname;
  const body = async () => { try { return await readBody(req); } catch { send(res, 400, { error: "Не удалось прочитать запрос." }); return null; } };

  if (req.method === "GET" && p === "/api/config") {
    return send(res, 200, {
      title: CONFIG.title, city: CONFIG.city, notes: CONFIG.notes, maxPerItem: CONFIG.maxPerItem, slotMinutes: SLOT_MIN,
      products: CONFIG.products, routes: CONFIG.routes.map(({ stock, ...r }) => r), weekend: weekendKey(), now: Date.now(),
      slots: Object.fromEntries(Object.values(POINTS).map((pt) => [pt.id, slotsOf(pt)])),
    });
  }
  if (req.method === "GET" && p === "/api/load") return send(res, 200, loadSummary(weekendKey()));

  if (req.method === "POST" && p === "/api/orders") {
    if (limited("o:" + clientIp(req), 40, 3600e3)) return send(res, 429, { error: "Слишком много заказов с этого подключения. Попробуйте через час." });
    const b = await body(); if (!b) return;
    if (b.website) return send(res, 400, { error: "Ошибка формы." });
    const pt = POINTS[b.point];
    if (!pt) return send(res, 400, { error: "Выберите точку из списка." });
    if (Date.now() > routeDeadline(pt.route)) return send(res, 400, { error: `Приём заказов на ${pt.route.day.toLowerCase()} (${pt.route.sub}) уже закрыт.` });
    if (pointClosed(pt)) return send(res, 400, { error: "Машина уже уехала с этой точки. Выберите другую." });
    const slots = slotsOf(pt);
    if (slots.length && !slots.includes(b.slot)) return send(res, 400, { error: "Выберите время, когда подойдёте." });
    const items = {};
    for (const [k, v] of Object.entries(b.items || {})) { const q = Math.floor(Number(v)); if (PRODUCTS[k] && q > 0) items[k] = Math.min(q, CONFIG.maxPerItem); }
    if (!Object.keys(items).length) return send(res, 400, { error: "Добавьте хотя бы один товар." });
    const first = cleanName(b.first), last = cleanName(b.last);
    if (!first || !last) return send(res, 400, { error: "Укажите имя и фамилию." });
    const wk = weekendKey();
    const rem = remainingOf(wk, pt.route.id);
    for (const [k, q] of Object.entries(items)) if (k in rem && q > rem[k]) {
      return send(res, 409, {
        error: rem[k] ? `${PRODUCTS[k].n}: осталось только ${rem[k]} ${PRODUCTS[k].u}. Уменьшите количество.` : `${PRODUCTS[k].n} на этот рейс закончилось. Уберите из заказа.`,
        remaining: rem,
      });
    }
    const o = {
      id: crypto.randomUUID(), weekend: wk, route: pt.route.id, point: pt.id, slot: slots.length ? b.slot : null, items,
      units: Object.values(items).reduce((a, x) => a + x, 0), first, last, code: makeCode(pt, wk),
      createdAt: Date.now(), issued: false, cancelled: false, token: crypto.randomBytes(16).toString("hex"),
    };
    orders.push(o); await saveOrders();
    return send(res, 201, Object.assign(forCustomer(o), { token: o.token }));
  }

  let m = p.match(/^\/api\/orders\/([\w-]+)\/(cancel|status)$/);
  if (m && req.method === "POST") {
    const b = await body(); if (!b) return;
    const o = orders.find((x) => x.id === m[1]);
    if (!o || !safeEq(b.token || "", o.token)) return send(res, 404, { error: "Заказ не найден." });
    if (m[2] === "status" || o.cancelled) return send(res, 200, forCustomer(o));
    if (o.issued) return send(res, 400, { error: "Заказ уже выдан." });
    const pt = POINTS[o.point];
    if (o.weekend !== weekendKey() || !pt || Date.now() > at(pt.route, pt.from)) {
      return send(res, 400, { error: "Отменить через сайт уже нельзя: машина на точке или уехала." });
    }
    o.cancelled = true; o.cancelledAt = Date.now(); await saveOrders();
    return send(res, 200, forCustomer(o));
  }

  // --- администратор ---
  if (req.method === "POST" && p === "/api/admin/login") {
    if (limited("l:" + clientIp(req), 8, 600e3)) return send(res, 429, { error: "Слишком много попыток. Подождите 10 минут." });
    const b = await body(); if (!b) return;
    if (!safeEq(sign("pw." + String(b.password || "")), sign("pw." + ADMIN_PASSWORD))) return send(res, 401, { error: "Неверный пароль." });
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    // SameSite=Lax, чтобы вход сохранялся при переходе по QR-коду из камеры телефона
    return send(res, 200, { ok: true }, { "Set-Cookie": `adm=${makeToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${14 * 86400}${secure}` });
  }
  if (p === "/api/admin/logout") return send(res, 200, { ok: true }, { "Set-Cookie": "adm=; Path=/; Max-Age=0" });

  if (!p.startsWith("/api/admin/")) return send(res, 404, { error: "Не найдено." });
  if (!isAdmin(req)) return send(res, 401, { error: "Нужно войти." });
  const wk = url.searchParams.get("weekend") || weekendKey();

  if (req.method === "GET" && p === "/api/admin/orders") {
    const weekends = [...new Set(orders.map((o) => o.weekend))].sort().reverse();
    return send(res, 200, {
      weekend: wk, current: weekendKey(), weekends, orders: orders.filter((o) => o.weekend === wk).map(forAdmin),
      stock: Object.fromEntries(CONFIG.routes.map((r) => [r.id, stockOf(wk, r.id)])),
      truck: truckView(wk), closed: Object.values(POINTS).filter((pt) => pointClosed(pt, wk)).map((pt) => pt.id),
      noShows: noShows(wk), slots: Object.fromEntries(Object.values(POINTS).map((pt) => [pt.id, slotsOf(pt)])),
    });
  }
  if (req.method === "GET" && p === "/api/admin/stats") return send(res, 200, statsAll());

  m = p.match(/^\/api\/admin\/orders\/([\w-]+)$/);
  if (m) {
    const o = orders.find((x) => x.id === m[1]);
    if (!o) return send(res, 404, { error: "Заказ не найден." });
    if (req.method === "GET") return send(res, 200, forAdmin(o));
    if (req.method === "PATCH") {
      const b = await body(); if (!b) return;
      if (b.issued === true) {
        const w = {};
        for (const [k, v] of Object.entries(b.weights || {})) {
          const n = Number(String(v).replace(",", "."));
          if (PRODUCTS[k] && o.items[k] && n > 0 && n < 200) w[k] = Math.round(n * 1000) / 1000;
        }
        Object.assign(o, { issued: true, cancelled: false, weights: w, amount: amountOf(o, w), issuedAt: Date.now() });
      } else if (b.issued === false) { o.issued = false; delete o.weights; delete o.amount; delete o.issuedAt; }
      await saveOrders(); return send(res, 200, forAdmin(o));
    }
    if (req.method === "DELETE") { orders = orders.filter((x) => x.id !== o.id); await saveOrders(); return send(res, 200, { ok: true }); }
  }

  if (req.method === "PUT" && p === "/api/admin/stock") {
    const b = await body(); if (!b) return;
    if (!ROUTES[b.route]) return send(res, 400, { error: "Неизвестный маршрут." });
    const s = {};
    for (const [k, v] of Object.entries(b.stock || {})) {
      if (v === "" || v === null) continue;
      const n = Math.floor(Number(v)); if (PRODUCTS[k] && n >= 0 && n < 100000) s[k] = n;
    }
    state.stock[wk] = state.stock[wk] || {}; state.stock[wk][b.route] = s; await saveState();
    return send(res, 200, { stock: s, remaining: remainingOf(wk, b.route) });
  }

  if (req.method === "POST" && p === "/api/admin/truck") {
    const b = await body(); if (!b) return;
    if (!ROUTES[b.route]) return send(res, 400, { error: "Неизвестный маршрут." });
    const t = truck(weekendKey(), b.route), pt = POINTS[b.point];
    if (b.action === "arrive" && pt) { t.at = pt.id; t.arrivedAt = Date.now(); delete t.departed[pt.id]; }
    else if (b.action === "depart" && pt) { t.departed[pt.id] = Date.now(); if (t.at === pt.id) { t.at = null; t.arrivedAt = null; } }
    else if (b.action === "undo" && pt) { delete t.departed[pt.id]; if (t.at === pt.id) { t.at = null; t.arrivedAt = null; } }
    else if (b.action === "delay") t.delay = Math.max(0, Math.min(240, Math.round(Number(b.delay) || 0)));
    else if (b.action === "reset") Object.assign(t, EMPTY_TRUCK());
    else return send(res, 400, { error: "Неизвестное действие." });
    await saveState(); return send(res, 200, truckView(weekendKey()));
  }

  if (req.method === "GET" && p === "/api/admin/export.csv") {
    const cols = ["Номер", "Имя", "Фамилия", "День", "Маршрут", "Точка", "Окно", ...CONFIG.products.map((x) => `${x.n}, ${x.u}`), "Всего позиций", "Статус", "Вес, кг", "Сумма, ₽", "Оформлен"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = orders.filter((o) => o.weekend === wk)
      .sort((a, b) => a.point.localeCompare(b.point, "ru", { numeric: true }) || String(a.slot).localeCompare(String(b.slot)) || a.createdAt - b.createdAt)
      .map((o) => {
        const pt = POINTS[o.point] || { route: {}, name: o.point };
        const weights = Object.entries(o.weights || {}).map(([k, w]) => `${PRODUCTS[k] ? PRODUCTS[k].n : k}: ${w}`).join("; ");
        return [o.code, o.first, o.last, pt.route.day, pt.route.sub, pt.name, o.slot || `${pt.from}–${pt.to}`, ...CONFIG.products.map((x) => o.items[x.id] || ""), o.units,
          o.cancelled ? "отменён" : o.issued ? "выдан" : "ждёт", weights, o.amount ?? "", new Date(o.createdAt + TZ).toISOString().replace("T", " ").slice(0, 16)].map(q).join(";");
      });
    return send(res, 200, "﻿" + [cols.map(q).join(";"), ...rows].join("\r\n"), {
      "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="zakazy-${wk}.csv"`,
    });
  }
  return send(res, 404, { error: "Не найдено." });
}

// ---------- статика ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  if (rel === "/admin") rel = "/admin.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, "Нет доступа");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Страница не найдена");
    const ext = path.extname(file);
    res.writeHead(200, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": [".html", ".js", ".css", ".webmanifest"].includes(ext) ? "no-cache" : "public, max-age=86400",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Метод не поддерживается");
    serveStatic(req, res, url);
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: "Ошибка сервера. Попробуйте ещё раз." }); }
}).listen(PORT, HOST, () => console.log(`Рыбный рейс: http://${HOST}:${PORT}  (заказов в базе: ${orders.length})`));
