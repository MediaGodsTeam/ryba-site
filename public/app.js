"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };
const rub = (n) => Math.round(n).toLocaleString("ru-RU") + " ₽";
const LVL_TXT = ["Свободно", "Спокойно", "Будет очередь", "Большая очередь"];
const lvl = (n) => (n === 0 ? 0 : n < 5 ? 1 : n < 12 ? 2 : 3);
const TZ = 3 * 3600e3;

let CFG = null, LOAD = null, ROUTES = [], POINTS = {}, PMAP = {}, SAT = null;
let current = "sat", skew = 0, qty = {}, form = { point: "", slot: "" };
const now = () => Date.now() + skew;

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
async function api(path, opts) {
  const r = await fetch(path.replace(/^\//, ""), Object.assign({ headers: { "Content-Type": "application/json" } }, opts));
  let data = {}; try { data = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(data.error || "Ошибка соединения."); e.status = r.status; e.data = data; throw e; }
  return data;
}

const fmt = (d, o) => d.toLocaleDateString("ru-RU", Object.assign({ timeZone: "UTC" }, o));
const dayDate = (r) => fmt(new Date(SAT.getTime() + r.off * 864e5), { day: "numeric", month: "long" });
const hmMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fmtMin = (x) => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, "0")}`;
const shift = (t, d) => (d ? fmtMin(hmMin(t) + d) : t);
const clock = (ms) => new Date(ms + TZ).toISOString().slice(11, 16).replace(/^0/, "");
const routeOpen = (r) => now() < (LOAD?.deadlines || {})[r.id];
const pointClosed = (pid) => (LOAD?.closed || []).includes(pid);
const truckOf = (rid) => (LOAD?.truck || {})[rid] || { delay: 0, at: null, departed: [] };
const remainingOf = (rid) => (LOAD?.remaining || {})[rid] || {};
const routePts = (r) => r.points.map((_, i) => POINTS[`${r.id}-${i + 1}`]);
const isRouteDay = (r) => { const d = SAT.getTime() + r.off * 864e5; return now() + TZ >= d && now() + TZ < d + 864e5; };

async function init() {
  try { CFG = await api("/api/config"); LOAD = await api("/api/load"); }
  catch { $("notice").textContent = "Не удаётся загрузить расписание. Проверьте интернет и обновите страницу."; $("notice").hidden = false; return; }
  skew = LOAD.now - Date.now();
  SAT = new Date(CFG.weekend + "T00:00:00Z");
  PMAP = Object.fromEntries(CFG.products.map((p) => [p.id, p]));
  ROUTES = CFG.routes;
  ROUTES.forEach((r) => r.points.forEach((p, i) => { POINTS[`${r.id}-${i + 1}`] = { id: `${r.id}-${i + 1}`, n: i + 1, name: p[0], addr: p[1], from: p[2], to: p[3], route: r }; }));
  const sun = new Date(SAT.getTime() + 864e5);
  $("dates").textContent = `${CFG.city} · ${fmt(SAT, { day: "numeric" })}–${fmt(sun, { day: "numeric", month: "long" })}`;
  $("foot").innerHTML = CFG.notes.map((n) => `<span>${esc(n)}</span>`).join("");
  const today = ROUTES.find(isRouteDay), firstOpen = ROUTES.find(routeOpen);
  current = (today || firstOpen || ROUTES[0]).id;
  render(); tick(); myBtnState(); stamp();
  setInterval(refresh, 20000); setInterval(tick, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  refreshMine();
}
function stamp() { $("updated").textContent = "Обновлено в " + new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) + ". Страница обновляется сама."; }
async function refresh() {
  try {
    LOAD = await api("/api/load"); skew = LOAD.now - Date.now();
    if (LOAD.weekend !== CFG.weekend) return location.reload();
    $("notice").hidden = true; stamp(); render();
    if (!scrim.hidden && $("of")) updateFormStock();
  } catch { $("notice").textContent = "Нет связи с сервером. Данные на странице могут быть неактуальными."; $("notice").hidden = false; }
}

/* ---------- таймер ---------- */
function tick() {
  if (!CFG) return;
  const r = ROUTES.find((x) => x.id === current), end = LOAD.deadlines[r.id], left = end - now(), el = $("timer");
  const endTxt = new Date(end + TZ).toLocaleString("ru-RU", { timeZone: "UTC", weekday: "long", hour: "2-digit", minute: "2-digit" });
  if (left <= 0) {
    el.className = "timer closed";
    $("tLab").innerHTML = `<b>Приём заказов на ${r.day.toLowerCase()} (${esc(r.sub)}) закрыт</b>Без заказа тоже можно купить: приходите на точку`;
    $("clock").innerHTML = "";
  } else {
    el.className = "timer" + (left < 2 * 3600e3 ? " soon" : "");
    const s = Math.floor(left / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60, two = (n) => String(n).padStart(2, "0");
    const units = (d ? [[d, plural(d, "день", "дня", "дней")]] : []).concat([[two(h), "ч"], [two(m), "мин"], [two(sec), "сек"]]);
    $("tLab").innerHTML = `<b>${left < 2 * 3600e3 ? "Осталось меньше 2 часов" : "До конца приёма заказов"}</b>${r.day}, ${esc(r.sub)} · принимаем до ${endTxt}`;
    $("clock").innerHTML = units.map(([v, l]) => `<div class="u"><b>${v}</b><small>${l}</small></div>`).join("");
  }
  el.hidden = false;
  const sig = ROUTES.map(routeOpen).join();
  if (tick.last !== sig) { tick.last = sig; render(); }
}

/* ---------- где машина ---------- */
function truckBanner(r) {
  const t = truckOf(r.id), pts = routePts(r), dep = new Set(t.departed);
  const delayTxt = t.delay ? ` Задерживаемся примерно на ${t.delay} мин.` : "";
  if (t.at && POINTS[t.at]) {
    const p = POINTS[t.at], next = pts.find((x) => x.n > p.n && !dep.has(x.id));
    return { cls: "here", title: `Машина на точке «${p.name}»`, text: `Стоит с ${clock(t.arrivedAt)}.${next ? ` Следующая остановка: ${next.name}, около ${shift(next.from, t.delay)}.` : " Это последняя точка рейса."}${delayTxt}` };
  }
  if (dep.size) {
    const next = pts.find((x) => !dep.has(x.id) && x.n > Math.max(...pts.filter((y) => dep.has(y.id)).map((y) => y.n)));
    if (!next) return { cls: "done", title: "Рейс завершён", text: "Машина объехала все точки. Спасибо, что были с нами!" };
    return { cls: "move", title: `Машина едет на «${next.name}»`, text: `Ожидаем около ${shift(next.from, t.delay)}.${delayTxt}` };
  }
  if (t.delay) return { cls: "move", title: `Задерживаемся примерно на ${t.delay} мин`, text: `Первая точка «${pts[0].name}» около ${shift(pts[0].from, t.delay)}.` };
  if (isRouteDay(r)) return { cls: "", title: "Машина ещё не выехала", text: `Первая точка «${pts[0].name}» в ${pts[0].from}. Здесь будет видно, где машина сейчас.` };
  return null;
}

/* ---------- дашборд ---------- */
function render() {
  if (!CFG) return;
  const by = LOAD.points || {}, all = Object.values(by);
  $("sOrders").textContent = all.reduce((a, s) => a + s.orders, 0);
  $("sFish").textContent = all.reduce((a, s) => a + s.trout, 0);
  let best = null; for (const [pid, s] of Object.entries(by)) if (POINTS[pid] && (!best || s.orders > best[1].orders)) best = [pid, s];
  $("sBusy").textContent = best ? `${POINTS[best[0]].name} · ${best[1].orders} ${plural(best[1].orders, "заказ", "заказа", "заказов")}` : "Пока заказов нет";

  $("tabs").innerHTML = ROUTES.map((r) => {
    const c = r.points.reduce((a, _, i) => a + (by[`${r.id}-${i + 1}`]?.orders || 0), 0);
    return `<button class="tab" role="tab" aria-selected="${r.id === current}" data-r="${r.id}">${r.day}, ${dayDate(r)}<span class="cnt">${c}</span><small>${esc(r.sub)}${routeOpen(r) ? "" : " · приём закрыт"}</small></button>`;
  }).join("");

  const r = ROUTES.find((x) => x.id === current), t = truckOf(r.id), dep = new Set(t.departed);
  const tb = truckBanner(r);
  $("truck").hidden = !tb;
  if (tb) { $("truck").className = "truck " + tb.cls; $("truck").innerHTML = `<span class="pulse" aria-hidden="true"></span><div><b>${esc(tb.title)}</b><p>${esc(tb.text)}</p></div>`; }

  const rem = remainingOf(r.id), remKeys = CFG.products.filter((p) => p.id in rem);
  $("stockline").hidden = !remKeys.length || !routeOpen(r);
  $("stockline").innerHTML = `<span class="lbl">На этот рейс осталось</span>` + remKeys.map((p) => `<span class="${rem[p.id] ? "" : "out"}">${esc(p.n)}: <b>${rem[p.id] || "закончилось"}</b>${rem[p.id] ? " " + p.u : ""}</span>`).join("");

  const pts = routePts(r), max = Math.max(5, ...pts.map((p) => by[p.id]?.orders || 0));
  const topId = pts.reduce((a, p) => ((by[p.id]?.orders || 0) > (by[a]?.orders || 0) ? p.id : a), pts[0].id);
  const open = routeOpen(r);
  $("route").innerHTML = pts.map((p) => {
    const s = by[p.id] || { orders: 0, units: 0 }, L = lvl(s.orders), closed = pointClosed(p.id), here = t.at === p.id, gone = dep.has(p.id);
    const chip = here ? "Машина здесь" : gone || closed ? "Машина уехала" : LVL_TXT[L];
    const time = t.delay && !gone ? `<s>${p.from}</s> ${shift(p.from, t.delay)}` : p.from;
    return `<li class="stop lvl${L}${closed && !here ? " closed" : ""}${here ? " here" : ""}">
      <div class="time">${time}<small>до ${shift(p.to, gone ? 0 : t.delay)}</small></div>
      <div class="dot" aria-hidden="true"></div>
      <button class="card ${p.id === topId && s.orders > 0 && !here ? "top1" : ""}" data-p="${p.id}" ${closed || !open ? 'aria-disabled="true"' : ""} aria-label="${esc(p.name)}, ${s.orders} заказов${open && !closed ? ". Заказать сюда" : ""}">
        <div><h3>${esc(p.name)}</h3><div class="addr">${esc(p.addr)}</div></div>
        <span class="chip">${chip}</span>
        <div class="bar"><div class="track"><div class="fill" style="width:${Math.round((s.orders / max) * 100)}%"></div></div>
        <span class="figs num"><b>${s.orders}</b> ${plural(s.orders, "заказ", "заказа", "заказов")} · ${s.units} поз.</span></div>
      </button></li>`;
  }).join("");
  const anyOpen = ROUTES.some(routeOpen);
  ["orderBtn", "orderBtn2"].forEach((id) => { $(id).disabled = !anyOpen; $(id).textContent = anyOpen ? "Заказать рыбу" : "Приём заказов закрыт"; });
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-r]"); if (t) { current = t.dataset.r; render(); tick(); return; }
  const c = e.target.closest("[data-p]"); if (c && c.getAttribute("aria-disabled") !== "true") openOrder(c.dataset.p);
});

/* ---------- шторка ---------- */
const scrim = $("scrim"), sheet = $("sheet");
let lastFocus = null;
function close() { scrim.hidden = true; sheet.innerHTML = ""; document.body.style.overflow = ""; lastFocus?.focus?.(); }
scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !scrim.hidden) close(); });
function openSheet(html, label) {
  lastFocus = document.activeElement;
  sheet.innerHTML = html; sheet.setAttribute("aria-label", label); scrim.hidden = false; sheet.scrollTop = 0; document.body.style.overflow = "hidden";
  sheet.querySelectorAll(".x,[data-close]").forEach((x) => x.addEventListener("click", close));
}

/* ---------- заказ ---------- */
const slotLvl = (n) => (n < 3 ? ["мало народу", "s1"] : n < 6 ? ["средне", "s2"] : ["много", "s3"]);
function lastOrder() { return lsGet("ryba-mine", []).find((o) => !o.cancelled) || null; }

function openOrder(pid) {
  qty = {}; form = { point: "", slot: "" };
  const opts = ROUTES.map((r) => {
    const ro = routeOpen(r);
    return `<optgroup label="${r.day}, ${dayDate(r)} — ${esc(r.sub)}${ro ? "" : " (приём закрыт)"}">${routePts(r).map((p) => {
      const dis = !ro || pointClosed(p.id);
      return `<option value="${p.id}" ${dis ? "disabled" : ""}>${p.from}–${p.to} · ${esc(p.name)}</option>`;
    }).join("")}</optgroup>`;
  }).join("");
  let last = "";
  const prods = CFG.products.map((p) => {
    const h = p.g !== last ? `<p class="grp">${esc(p.g)}</p>` : ""; last = p.g;
    return h + `<div class="prod" id="pr-${p.id}"><div><div class="pn">${esc(p.n)}</div><div class="pd">${esc(p.d)}<span class="left" id="lf-${p.id}"></span></div></div>
      <div class="stepper"><button type="button" data-m="${p.id}" aria-label="Убрать: ${esc(p.n)}">−</button><output id="q-${p.id}" aria-live="polite">0</output><button type="button" class="plus" data-pl="${p.id}" aria-label="Добавить: ${esc(p.n)}">+</button></div></div>`;
  }).join("");
  const name = lsGet("ryba-name", { f: "", l: "" }), prev = lastOrder();
  const prevTxt = prev ? Object.entries(prev.items).map(([k, q]) => `${PMAP[k]?.n || k} × ${q}`).join(", ") : "";
  openSheet(`<div class="sheet-head"><h2>Заказ</h2><button class="x" aria-label="Закрыть">×</button></div>
  ${prev ? `<button type="button" class="repeat" id="repeat"><b>Повторить прошлый заказ</b><span>${esc(prevTxt)}</span></button>` : ""}
  <form id="of" class="step" novalidate style="gap:18px">
    <div class="step"><label class="lbl" for="pt">1. Куда приедете</label><select id="pt"><option value="">Выберите точку</option>${opts}</select>
      <div id="slotWrap" hidden><span class="lbl" style="margin-top:6px;display:block">Во сколько подойдёте</span><div class="slots" id="slots" role="radiogroup" aria-label="Время"></div></div></div>
    <div class="step"><span class="lbl">2. Что берёте</span>${prods}</div>
    <div class="step"><span class="lbl">3. На кого заказ</span><div class="names">
      <input type="text" id="fn" placeholder="Имя" autocomplete="given-name" maxlength="40" value="${esc(name.f || "")}" aria-label="Имя">
      <input type="text" id="ln" placeholder="Фамилия" autocomplete="family-name" maxlength="40" value="${esc(name.l || "")}" aria-label="Фамилия"></div>
      <p class="fine">Имя и фамилия нужны только для выдачи заказа. Телефон не нужен.</p></div>
    <div class="hp" aria-hidden="true"><input type="text" id="website" tabindex="-1" autocomplete="off"></div>
    <div class="submit"><p class="err" id="ferr" hidden></p><div class="sum" id="fsum">Пока ничего не выбрано</div><button class="btn btn-main" type="submit" id="fsub">Оформить заказ</button></div>
  </form>`, "Оформление заказа");
  sheet.querySelectorAll("[data-pl],[data-m]").forEach((b) => b.addEventListener("click", () => { const id = b.dataset.pl || b.dataset.m; setQty(id, (qty[id] || 0) + (b.dataset.pl ? 1 : -1)); }));
  $("pt").addEventListener("change", () => selectPoint($("pt").value));
  $("of").addEventListener("submit", submitOrder);
  if (prev) $("repeat").addEventListener("click", () => repeatOrder(prev));
  if (pid && !pointClosed(pid) && routeOpen(POINTS[pid].route)) { $("pt").value = pid; selectPoint(pid); }
  updateFormStock();
}
function selectPoint(pid) {
  form.point = pid; form.slot = "";
  const slots = (CFG.slots || {})[pid] || [], counts = (LOAD.points[pid] || {}).slots || {};
  $("slotWrap").hidden = !slots.length;
  $("slots").innerHTML = slots.map((s) => { const n = counts[s] || 0, [t, c] = slotLvl(n); return `<button type="button" role="radio" aria-checked="false" class="slot ${c}" data-slot="${s}"><b>${s}</b><small>${n ? `${n} ${plural(n, "заказ", "заказа", "заказов")} · ${t}` : "свободно"}</small></button>`; }).join("");
  $("slots").querySelectorAll("[data-slot]").forEach((b) => b.addEventListener("click", () => {
    form.slot = b.dataset.slot; $("slots").querySelectorAll("[data-slot]").forEach((x) => x.setAttribute("aria-checked", x === b ? "true" : "false"));
  }));
  updateFormStock();
}
function formRem() { const p = POINTS[form.point]; return p ? remainingOf(p.route.id) : {}; }
function setQty(id, v) {
  const rem = formRem(), cap = Math.min(CFG.maxPerItem, id in rem ? rem[id] : Infinity);
  qty[id] = Math.max(0, Math.min(cap, v));
  $("q-" + id).innerHTML = qty[id] ? `${qty[id]}<small>${PMAP[id].u}</small>` : "0";
  $("pr-" + id).classList.toggle("on", qty[id] > 0);
  updateSum(); updateFormStock();
}
function updateFormStock() {
  const rem = formRem();
  CFG.products.forEach((p) => {
    const lf = $("lf-" + p.id); if (!lf) return;
    const has = p.id in rem, r = rem[p.id], q = qty[p.id] || 0;
    lf.textContent = has ? (r ? ` · осталось ${r} ${p.u}` : " · закончилось") : "";
    lf.className = "left" + (has && r <= 5 ? " low" : "");
    $("pr-" + p.id).classList.toggle("out", has && !r);
    sheet.querySelector(`[data-pl="${p.id}"]`).disabled = has && q >= r;
    if (has && q > r) setQty(p.id, r);
  });
}
function updateSum() {
  const ent = Object.entries(qty).filter(([, q]) => q > 0);
  if (!ent.length) { $("fsum").textContent = "Пока ничего не выбрано"; return; }
  let sum = 0, unknown = [];
  for (const [k, q] of ent) { const p = PMAP[k]; if (p.per === "kg") { if (p.approxKg) sum += q * p.approxKg * p.price; else unknown.push(p.n.toLowerCase()); } else sum += q * p.price; }
  const u = ent.reduce((a, [, q]) => a + q, 0);
  $("fsum").textContent = `${ent.length} ${plural(ent.length, "товар", "товара", "товаров")}, ${u} поз. · примерно ${rub(sum)}${unknown.length ? ` + ${unknown.join(", ")}` : ""}. Точная сумма после взвешивания`;
}
function repeatOrder(prev) {
  const p = POINTS[prev.point];
  if (p && routeOpen(p.route) && !pointClosed(p.id)) { $("pt").value = p.id; selectPoint(p.id); }
  CFG.products.forEach((x) => setQty(x.id, 0));
  Object.entries(prev.items).forEach(([k, q]) => { if (PMAP[k]) setQty(k, q); });
  $("repeat").hidden = true;
  const err = $("ferr"); err.hidden = false; err.className = "ok";
  err.textContent = form.point ? "Товары и точка подставлены. Выберите время и проверьте количество." : "Товары подставлены. Выберите точку и время.";
}

async function submitOrder(e) {
  e.preventDefault();
  const f = $("fn").value.trim(), l = $("ln").value.trim(), slots = (CFG.slots || {})[form.point] || [];
  const items = Object.fromEntries(Object.entries(qty).filter(([, q]) => q > 0));
  const err = $("ferr"); err.className = "err";
  const miss = !form.point ? "Выберите точку, куда приедете." : slots.length && !form.slot ? "Выберите время, когда подойдёте." : !Object.keys(items).length ? "Добавьте хотя бы один товар кнопкой «+»." : !f || !l ? "Укажите имя и фамилию: по ним выдадут заказ." : "";
  if (miss) { err.textContent = miss; err.hidden = false; return; }
  err.hidden = true; const btn = $("fsub"); btn.disabled = true; btn.textContent = "Отправляем…";
  try {
    const o = await api("/api/orders", { method: "POST", body: JSON.stringify({ point: form.point, slot: form.slot, items, first: f, last: l, website: $("website").value }) });
    lsSet("ryba-name", { f, l });
    const mine = lsGet("ryba-mine", []); mine.unshift(o); lsSet("ryba-mine", mine.slice(0, 30));
    myBtnState(); showTicket(o); refresh();
  } catch (ex) {
    btn.disabled = false; btn.textContent = "Оформить заказ";
    if (ex.data && ex.data.remaining && form.point) { LOAD.remaining[POINTS[form.point].route.id] = ex.data.remaining; updateFormStock(); }
    err.textContent = ex.status ? ex.message : "Заказ не отправился: нет связи. Проверьте интернет и нажмите ещё раз."; err.hidden = false;
  }
}

/* ---------- талон ---------- */
const qrUrl = (o) => new URL(`admin.html#o-${o.id}`, location.href).href;
function canCancel(o) { const p = POINTS[o.point]; return p && !o.cancelled && !o.issued && o.weekend === CFG.weekend && now() < SAT.getTime() + p.route.off * 864e5 + hmMin(p.from) * 60e3 - TZ; }
function showTicket(o) {
  const p = POINTS[o.point] || { route: { day: "" }, name: o.point, addr: "", from: "", to: "" };
  const when = new Date(o.createdAt).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  const status = o.cancelled ? `<div class="status cancelled">Заказ отменён</div>` : o.issued ? `<div class="status issued">Заказ выдан. Спасибо!</div>` : "";
  let qr = ""; try { qr = window.QR.toSvg(qrUrl(o)); } catch {}
  openSheet(`<div class="sheet-head"><h2>${o.cancelled ? "Заказ отменён" : "Ваш заказ"}</h2><button class="x" aria-label="Закрыть">×</button></div>
  ${status}
  <div class="ticket${o.cancelled ? " void" : ""}">
    <div class="ticket-top"><div><div class="lab">Номер заказа</div><div class="code num">${esc(o.code)}</div></div>
      <div style="text-align:right"><div class="lab">${esc(p.route.day)}</div><div style="font-weight:800;font-size:18px">${p.route.off !== undefined ? dayDate(p.route) : ""}</div></div></div>
    <div class="ticket-body">
      <div class="tb-row"><div style="min-width:0"><div class="who">${esc(o.first)} ${esc(o.last)}</div>
        <dl class="kv"><dt>Точка</dt><dd>${esc(p.name)}</dd><dt>Адрес</dt><dd>${esc(p.addr)}</dd><dt>Время</dt><dd class="num">${esc(o.slot || `${p.from}–${p.to}`)}</dd></dl></div>
        <div class="qr">${qr}</div></div>
      <ul>${Object.entries(o.items).map(([k, q]) => `<li><span>${esc(PMAP[k]?.n || k)}</span><b>${q} ${PMAP[k]?.u || ""}</b></li>`).join("")}</ul>
      <div class="stamp num">Оформлен ${when} · оплата на месте наличными или по QR</div>
    </div>
  </div>
  ${o.cancelled ? "" : `<div class="shot">Покажите талон или QR-код при получении</div>
  <div class="row"><button class="btn btn-main" id="saveImg">Сохранить в галерею</button><button class="btn" data-close>Готово</button></div>
  <p class="fine" id="saveMsg">Можно просто сделать скриншот. Талон также хранится в «Мои заказы» на этом телефоне.</p>`}
  ${canCancel(o) ? `<button class="linkbtn" id="cancelBtn">Отменить заказ</button><p class="fine">Отменить можно до ${p.from} в день выдачи. Отмена освобождает рыбу для других покупателей.</p>` : ""}`, "Талон заказа");
  $("saveImg")?.addEventListener("click", () => saveTicket(o, p, when));
  $("cancelBtn")?.addEventListener("click", (e) => cancelOrder(o, e.currentTarget));
}
async function cancelOrder(o, btn) {
  if (btn.dataset.sure !== "1") { btn.dataset.sure = "1"; btn.textContent = "Нажмите ещё раз, чтобы отменить"; btn.classList.add("danger"); return; }
  btn.disabled = true; btn.textContent = "Отменяем…";
  try {
    const u = await api(`/api/orders/${o.id}/cancel`, { method: "POST", body: JSON.stringify({ token: o.token }) });
    const mine = lsGet("ryba-mine", []).map((x) => (x.id === o.id ? Object.assign(x, u) : x)); lsSet("ryba-mine", mine);
    showTicket(Object.assign(o, u)); refresh(); myBtnState();
  } catch (ex) { btn.disabled = false; btn.textContent = ex.status ? ex.message : "Нет связи. Попробуйте ещё раз."; }
}
async function refreshMine() {
  const mine = lsGet("ryba-mine", []); let changed = false;
  for (const o of mine) if (o.weekend === CFG.weekend && o.token && !o.cancelled && !o.issued) {
    try { const u = await api(`/api/orders/${o.id}/status`, { method: "POST", body: JSON.stringify({ token: o.token }) }); if (u.cancelled !== o.cancelled || u.issued !== o.issued) { Object.assign(o, u); changed = true; } } catch {}
  }
  if (changed) { lsSet("ryba-mine", mine); myBtnState(); }
}

function ticketCanvas(o, p, when) {
  const W = 1080, pad = 72, items = Object.entries(o.items), H = 800 + items.length * 74;
  const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d");
  const font = (w, s) => `${w} ${s}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  x.fillStyle = "#EDF2F4"; x.fillRect(0, 0, W, H);
  x.fillStyle = "#FFFFFF"; roundRect(x, 36, 36, W - 72, H - 72, 40); x.fill();
  x.fillStyle = "#DE5934"; roundRect(x, 36, 36, W - 72, 250, 40, true); x.fill();
  x.fillStyle = "#FFFFFF"; x.font = font(600, 30); x.fillText("НОМЕР ЗАКАЗА", pad + 20, 120);
  x.font = font(900, 110); x.fillText(o.code, pad + 20, 235);
  x.textAlign = "right"; x.font = font(600, 30); x.fillText(p.route.day.toUpperCase(), W - pad - 20, 120);
  x.font = font(800, 46); x.fillText(dayDate(p.route), W - pad - 20, 180); x.textAlign = "left";
  const qs = 260; try { window.QR.drawTo(x, qrUrl(o), W - pad - 20 - qs, 316, qs); } catch {}
  let y = 380; const tw = W - 2 * pad - 40 - qs - 30;
  x.fillStyle = "#0F2433"; x.font = font(800, 56); x.fillText(fit(x, `${o.first} ${o.last}`, tw), pad + 20, y); y += 76;
  for (const [k, v] of [["Точка", p.name], ["Адрес", p.addr], ["Время", o.slot || `${p.from}–${p.to}`]]) {
    x.fillStyle = "#566B78"; x.font = font(400, 32); x.fillText(k, pad + 20, y); x.fillStyle = "#0F2433"; x.font = font(700, 32); x.fillText(fit(x, v, tw - 140), pad + 160, y); y += 52;
  }
  y = Math.max(y, 316 + qs) + 80; x.strokeStyle = "#D4DFE4"; x.lineWidth = 3; x.setLineDash([12, 10]);
  for (const [k, q] of items) {
    x.beginPath(); x.moveTo(pad + 20, y - 40); x.lineTo(W - pad - 20, y - 40); x.stroke();
    x.fillStyle = "#0F2433"; x.font = font(500, 34); x.fillText(fit(x, PMAP[k]?.n || k, W - 2 * pad - 260), pad + 20, y + 10);
    x.textAlign = "right"; x.font = font(800, 36); x.fillText(`${q} ${PMAP[k]?.u || ""}`, W - pad - 20, y + 10); x.textAlign = "left"; y += 74;
  }
  x.beginPath(); x.moveTo(pad + 20, y - 40); x.lineTo(W - pad - 20, y - 40); x.stroke(); x.setLineDash([]);
  x.fillStyle = "#566B78"; x.font = font(400, 28); x.fillText(`Оформлен ${when} · оплата на месте`, pad + 20, y + 20);
  x.fillStyle = "#DE5934"; x.font = font(800, 32); x.fillText("Рыбный рейс · покажите при получении", pad + 20, H - 90);
  return c;
}
function roundRect(x, X, Y, w, h, r, topOnly) { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); if (topOnly) { x.lineTo(X + w, Y + h); x.lineTo(X, Y + h); } else { x.arcTo(X + w, Y + h, X, Y + h, r); x.arcTo(X, Y + h, X, Y, r); } x.arcTo(X, Y, X + w, Y, r); x.closePath(); }
function fit(x, s, w) { s = String(s); if (x.measureText(s).width <= w) return s; while (s.length > 1 && x.measureText(s + "…").width > w) s = s.slice(0, -1); return s + "…"; }
async function saveTicket(o, p, when) {
  const msg = $("saveMsg");
  const blob = await new Promise((r) => ticketCanvas(o, p, when).toBlob(r, "image/png"));
  const file = new File([blob], `talon-${o.code}.png`, { type: "image/png" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: `Заказ ${o.code}` }); msg.textContent = "Выберите «Сохранить изображение», чтобы талон оказался в галерее."; return; }
  } catch (e) { if (e && e.name === "AbortError") return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  msg.textContent = "Талон скачан в «Загрузки». Если не получилось, сделайте скриншот этого экрана.";
}

/* ---------- мои заказы ---------- */
const getMine = () => lsGet("ryba-mine", []).filter((o) => CFG && o.weekend === CFG.weekend);
function myBtnState() { const has = getMine().length > 0; $("myBtn").hidden = !has; $("myBtn2").hidden = !has; }
function openMine() {
  const m = getMine(); if (m.length === 1) return showTicket(m[0]);
  openSheet(`<div class="sheet-head"><h2>Мои заказы</h2><button class="x" aria-label="Закрыть">×</button></div>
    <div class="mylist">${m.map((o, i) => `<button data-i="${i}"><b>${esc(o.code)}</b>${esc(POINTS[o.point]?.name || "")} · ${esc(o.slot || POINTS[o.point]?.from || "")}${o.cancelled ? " · отменён" : o.issued ? " · выдан" : ""}</button>`).join("")}</div>`, "Мои заказы");
  sheet.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => showTicket(m[+b.dataset.i])));
}
$("myBtn").addEventListener("click", openMine); $("myBtn2").addEventListener("click", openMine);
$("orderBtn").addEventListener("click", () => openOrder("")); $("orderBtn2").addEventListener("click", () => openOrder(""));

/* ---------- установка на телефон ---------- */
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $("install").hidden = false; $("installTxt").textContent = "Добавьте сайт на главный экран, чтобы открывать его как приложение."; });
$("installBtn").addEventListener("click", async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $("install").hidden = true; });
(() => {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (ios && !standalone) { $("install").hidden = false; $("installBtn").hidden = true; $("installTxt").textContent = "Чтобы открывать как приложение: нажмите «Поделиться», затем «На экран „Домой“»."; }
})();
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));

init();
