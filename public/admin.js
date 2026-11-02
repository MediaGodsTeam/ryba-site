"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rub = (n) => Math.round(n).toLocaleString("ru-RU") + " ₽";
const TZ = 3 * 3600e3;
const clock = (ms) => new Date(ms + TZ).toISOString().slice(11, 16).replace(/^0/, "");
const nameKey = (o) => `${o.first} ${o.last}`.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
const wkLabel = (w) => new Date(w + "T00:00:00Z").toLocaleDateString("ru-RU", { timeZone: "UTC", day: "numeric", month: "long" });

let CFG, DATA, PMAP = {}, POINTS = {}, current = "sat", weekend = "", busy = false, openWeigh = null, draft = {}, hitId = null;

async function api(path, opts) {
  const r = await fetch(path.replace(/^\//, ""), Object.assign({ headers: { "Content-Type": "application/json" }, credentials: "same-origin" }, opts));
  let d = {}; try { d = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(d.error || "Ошибка соединения."); e.status = r.status; throw e; }
  return d;
}

async function start() {
  CFG = await api("/api/config");
  PMAP = Object.fromEntries(CFG.products.map((p) => [p.id, p]));
  CFG.routes.forEach((r) => r.points.forEach((p, i) => { POINTS[`${r.id}-${i + 1}`] = { id: `${r.id}-${i + 1}`, n: i + 1, name: p[0], from: p[2], to: p[3], route: r }; }));
  try { await openFromHash(); await load(); showApp(); } catch (e) { if (e.status === 401) showLogin(); else $("sub").textContent = e.message; }
  setInterval(() => {
    const typing = document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName);
    if (!$("app").hidden && !busy && !openWeigh && !typing && document.visibilityState === "visible" && !$("work").hidden) load().catch(() => {});
  }, 15000);
  window.addEventListener("hashchange", () => openFromHash().then(load).catch(() => {}));
}
function showLogin() { $("login").hidden = false; $("app").hidden = true; $("logout").hidden = true; $("pw").focus(); }
function showApp() { $("login").hidden = true; $("app").hidden = false; $("logout").hidden = false; }

// Переход по QR-коду из талона: /admin#o-<id заказа>
async function openFromHash() {
  const m = location.hash.match(/^#o-([\w-]+)$/); if (!m) return;
  const o = await api(`/api/admin/orders/${m[1]}`);
  weekend = o.weekend; current = o.route; hitId = o.id; $("q").value = o.code;
  if (!o.issued && !o.cancelled) openWeigh = o.id;
  history.replaceState(null, "", location.pathname);
}

$("login").addEventListener("submit", async (e) => {
  e.preventDefault(); $("lerr").hidden = true;
  try { await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: $("pw").value }) }); $("pw").value = ""; await openFromHash().catch(() => {}); await load(); showApp(); }
  catch (ex) { $("lerr").textContent = ex.message; $("lerr").hidden = false; }
});
$("logout").addEventListener("click", async () => { await api("/api/admin/logout", { method: "POST" }).catch(() => {}); showLogin(); });

async function load() {
  DATA = await api("/api/admin/orders" + (weekend ? `?weekend=${weekend}` : ""));
  weekend = DATA.weekend;
  const list = [...new Set([DATA.current, ...DATA.weekends])].sort().reverse();
  $("wk").innerHTML = list.map((w) => `<option value="${w}" ${w === weekend ? "selected" : ""}>Выходные ${wkLabel(w)}${w === DATA.current ? " (текущие)" : ""}</option>`).join("");
  render();
}
$("csv").addEventListener("click", async (e) => {
  e.preventDefault(); const b = $("csv"), t = b.textContent; b.textContent = "Готовим…";
  try {
    const r = await fetch(`api/admin/export.csv?weekend=${weekend}`, { credentials: "same-origin" }); if (!r.ok) throw new Error();
    const blob = await r.blob(), a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `zakazy-${weekend}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); b.textContent = t;
  } catch { b.textContent = "Не удалось, ещё раз"; }
});
$("wk").addEventListener("change", () => { weekend = $("wk").value; openWeigh = null; load(); });

const live = (o) => !o.cancelled;
const sumItems = (list) => { const t = {}; list.filter(live).forEach((o) => Object.entries(o.items).forEach(([k, q]) => (t[k] = (t[k] || 0) + q))); return t; };
const itemsText = (items) => Object.entries(items).map(([k, q]) => `${PMAP[k]?.n || k} — ${q} ${PMAP[k]?.u || ""}`).join(", ");
const revenue = (list) => list.filter((o) => o.issued).reduce((a, o) => a + (o.amount || 0), 0);

function render() {
  const q = $("q").value.trim().toLowerCase(), isCur = weekend === DATA.current;
  const byRoute = (rid) => DATA.orders.filter((o) => o.route === rid);
  $("tabs").innerHTML = CFG.routes.map((r) => {
    const l = byRoute(r.id).filter(live), done = l.filter((o) => o.issued).length;
    return `<button class="tab" role="tab" aria-selected="${r.id === current}" data-r="${r.id}">${r.day}<span class="cnt">${l.length}</span><small>${esc(r.sub)} · выдано ${done}</small></button>`;
  }).join("");
  const r = CFG.routes.find((x) => x.id === current);
  let orders = byRoute(r.id);
  if (q) orders = DATA.orders.filter((o) => (o.code + " " + o.first + " " + o.last).toLowerCase().includes(q));

  // --- машина ---
  const t = DATA.truck[r.id];
  $("truckPanel").hidden = !!q;
  $("truckPanel").innerHTML = isCur ? `<div class="truckctl"><div><b>Машина · ${esc(r.day.toLowerCase())}, ${esc(r.sub)}</b><div class="fine">${t.at ? `Стоит на точке «${esc(POINTS[t.at]?.name)}» с ${clock(t.arrivedAt)}` : t.departed.length ? `Проехала точек: ${t.departed.length} из ${r.points.length}` : "Ещё не выехала"}. Покупатели видят это на сайте.</div></div>
    <label>Задержка <select id="delay">${[0, 10, 15, 20, 30, 45, 60, 90].map((d) => `<option value="${d}" ${t.delay === d ? "selected" : ""}>${d ? `${d} мин` : "нет"}</option>`).join("")}</select></label></div>`
    : `<div class="fine">Это прошедшие выходные: управление машиной и остатками доступно только для текущих.</div>`;
  $("delay")?.addEventListener("change", (e) => truckAct({ action: "delay", delay: Number(e.target.value) }));

  // --- загрузка машины и остатки ---
  const ordered = sumItems(orders), stock = DATA.stock[r.id] || {};
  if (q) { $("totTitle").textContent = `Найдено заказов: ${orders.length}`; $("stock").innerHTML = totalsChips(ordered); }
  else {
    $("totTitle").textContent = `Загрузка машины · ${r.day.toLowerCase()}, ${r.sub} · выручка ${rub(revenue(orders))}`;
    $("stock").innerHTML = `<table class="stk"><thead><tr><th>Товар</th><th>Заказано</th><th>Везём</th><th>Свободно</th></tr></thead><tbody>${CFG.products.map((p) => {
      const o = ordered[p.id] || 0, s = stock[p.id], free = s === undefined ? "—" : Math.max(0, s - o);
      return `<tr><td>${esc(p.n)}, ${p.u}</td><td>${o || ""}</td><td>${isCur ? `<input type="number" inputmode="numeric" min="0" data-stk="${p.id}" value="${s ?? ""}" placeholder="без лимита" aria-label="Везём: ${esc(p.n)}">` : s ?? "—"}</td><td class="free ${free !== "—" && free <= 3 ? "low" : ""}">${free}</td></tr>`;
    }).join("")}</tbody></table>
    ${isCur ? `<div class="bar2" style="margin-top:10px"><span class="fine">Пустое поле — без лимита. Когда свободных не останется, на сайте товар станет недоступен.</span><button class="btn sm go" id="saveStock">Сохранить</button></div>` : ""}`;
    $("saveStock")?.addEventListener("click", saveStock);
  }

  // --- точки ---
  const pids = q ? [...new Set(orders.map((o) => o.point))] : r.points.map((_, i) => `${r.id}-${i + 1}`);
  $("points").innerHTML = pids.map((pid) => {
    const p = POINTS[pid] || { name: pid, from: "", to: "", route: { day: "" } };
    const list = orders.filter((o) => o.point === pid).sort((a, b) => String(a.slot).localeCompare(String(b.slot), "ru", { numeric: true }) || a.createdAt - b.createdAt);
    const act = list.filter(live), done = act.filter((o) => o.issued).length, tt = DATA.truck[p.route.id] || {};
    const here = tt.at === pid, gone = (tt.departed || []).includes(pid);
    const ctl = isCur && !q ? `<div class="tbtns">${here ? `<span class="tchip here">Машина здесь</span><button class="btn sm" data-tr="depart" data-pt="${pid}">Уехали</button>` : gone ? `<span class="tchip gone">Уехали</span><button class="btn sm" data-tr="undo" data-pt="${pid}">Отменить</button>` : `<button class="btn sm go" data-tr="arrive" data-pt="${pid}">Приехали</button>`}</div>` : "";
    let slot = null, rowsHtml = "";
    for (const o of list) {
      if (o.slot !== slot) { slot = o.slot; if (o.slot) rowsHtml += `<div class="slothead">${esc(o.slot)} · ${list.filter((x) => x.slot === o.slot && live(x)).length} зак.</div>`; }
      rowsHtml += orderRow(o);
    }
    return `<div class="panel"><div class="ph"><h4>${p.from}–${p.to} · ${esc(p.name)}${q ? ` · ${esc(p.route.day)}` : ""} <span class="prog">· выдано ${done} из ${act.length}${done ? ` · ${rub(revenue(list))}` : ""}</span></h4>${ctl}</div>
      ${act.length ? totalsChips(sumItems(list)) : ""}${rowsHtml}</div>`;
  }).join("") || '<p class="empty">Ничего не найдено</p>';
  bindRows();
  if (hitId) { const el = document.querySelector(`[data-oid="${hitId}"]`); if (el) { el.scrollIntoView({ block: "center" }); const inp = el.querySelector("input"); inp && inp.focus({ preventScroll: true }); } hitId = null; }
}
function totalsChips(t) { const e = CFG.products.filter((p) => t[p.id]); return `<div class="totals">${e.length ? e.map((p) => `<span>${esc(p.n)}: <b>${t[p.id]}</b> ${p.u}</span>`).join("") : '<p class="empty">Заказов нет</p>'}</div>`; }

function orderRow(o) {
  const ns = DATA.noShows[nameKey(o)] || 0;
  const badges = (o.cancelled ? `<span class="badge cx">отменён</span>` : "") + (o.issued ? `<span class="badge ok">выдан${o.amount != null ? ` · ${rub(o.amount)}` : ""}</span>` : "") +
    (ns ? `<span class="badge ns">не забрал ${ns} ${ns === 1 ? "раз" : ns < 5 ? "раза" : "раз"}</span>` : "");
  const actions = o.cancelled ? `<button class="mini danger" data-del="${o.id}">Удалить</button>`
    : o.issued ? `<button class="mini" data-unissue="${o.id}">Вернуть</button>`
    : `<button class="btn sm go" data-issue="${o.id}">Выдать</button>`;
  return `<div class="ord ${o.issued ? "done" : ""} ${o.cancelled ? "cancelled" : ""} ${hitId === o.id ? "hit" : ""}" data-oid="${o.id}">
    <div class="who"><b>${esc(o.code)}</b>${esc(o.first)} ${esc(o.last)}${badges}<div class="what">${esc(itemsText(o.items))}</div></div>
    <div>${actions}</div>${openWeigh === o.id ? weighForm(o) : ""}</div>`;
}
function weighForm(o) {
  const d = draft[o.id] || {};
  const rows = Object.entries(o.items).map(([k, q]) => {
    const p = PMAP[k]; if (!p) return "";
    if (p.per === "kg") return `<div class="wrow"><span>${esc(p.n)} × ${q} ${p.u}<br><span class="fine">${p.price} ₽/кг${p.approxKg ? ` · ожидаем ≈${(p.approxKg * q).toLocaleString("ru-RU")} кг` : ""}</span></span><input type="text" inputmode="decimal" placeholder="вес, кг" data-w="${k}" data-o="${o.id}" value="${esc(d[k] || "")}" aria-label="Вес: ${esc(p.n)}"></div>`;
    return `<div class="wrow"><span>${esc(p.n)} × ${q}</span><span class="fixed">${rub(q * p.price)}</span></div>`;
  }).join("");
  return `<div class="weigh">${rows}<div class="wsum" id="ws-${o.id}">${sumText(o)}</div>
    <div class="row"><button class="btn btn-main" data-confirm="${o.id}">Выдано</button><button class="btn" data-skip="${o.id}">Без взвешивания</button><button class="btn" data-closew>Закрыть</button></div></div>`;
}
function calc(o) {
  const d = draft[o.id] || {}; let sum = 0, missing = 0;
  for (const [k, q] of Object.entries(o.items)) { const p = PMAP[k]; if (!p) continue; if (p.per === "kg") { const w = Number(String(d[k] || "").replace(",", ".")); if (w > 0) sum += w * p.price; else missing++; } else sum += q * p.price; }
  return { sum, missing };
}
function sumText(o) { const { sum, missing } = calc(o); return missing ? `${rub(sum)} + ещё ${missing} ${missing === 1 ? "позиция" : "позиции"} без веса` : `К оплате: ${rub(sum)}`; }

function bindRows() {
  document.querySelectorAll("[data-w]").forEach((inp) => inp.addEventListener("input", () => {
    const id = inp.dataset.o; draft[id] = draft[id] || {}; draft[id][inp.dataset.w] = inp.value;
    const o = DATA.orders.find((x) => x.id === id); $("ws-" + id).textContent = sumText(o);
  }));
}

async function saveStock() {
  const stock = {}; document.querySelectorAll("[data-stk]").forEach((i) => { stock[i.dataset.stk] = i.value; });
  const b = $("saveStock"); b.disabled = true; b.textContent = "Сохраняем…";
  try { const r = await api("/api/admin/stock", { method: "PUT", body: JSON.stringify({ route: current, stock }) }); DATA.stock[current] = r.stock; render(); }
  catch (e) { b.disabled = false; b.textContent = "Не сохранилось, ещё раз"; }
}
async function truckAct(body) {
  busy = true;
  try { DATA.truck = await api("/api/admin/truck", { method: "POST", body: JSON.stringify(Object.assign({ route: current }, body)) }); render(); }
  catch (e) { $("sub").textContent = e.message; } finally { busy = false; }
}
async function patch(id, body) {
  busy = true;
  try { const o = await api(`/api/admin/orders/${id}`, { method: "PATCH", body: JSON.stringify(body) }); DATA.orders[DATA.orders.findIndex((x) => x.id === id)] = o; openWeigh = null; delete draft[id]; render(); }
  catch (e) { if (e.status === 401) showLogin(); else $("sub").textContent = e.message; } finally { busy = false; }
}

$("q").addEventListener("input", () => render());
$("clearQ").addEventListener("click", () => { $("q").value = ""; render(); $("q").focus(); });
document.addEventListener("click", async (e) => {
  const el = (s) => e.target.closest(s);
  let t;
  if ((t = el("[data-v]"))) { document.querySelectorAll("[data-v]").forEach((b) => b.setAttribute("aria-selected", b === t ? "true" : "false")); $("work").hidden = t.dataset.v !== "work"; $("stats").hidden = t.dataset.v !== "stats"; if (t.dataset.v === "stats") loadStats(); return; }
  if ((t = el("[data-r]"))) { current = t.dataset.r; $("q").value = ""; openWeigh = null; render(); return; }
  if ((t = el("[data-tr]"))) return truckAct({ action: t.dataset.tr, point: t.dataset.pt });
  if ((t = el("[data-issue]"))) { openWeigh = t.dataset.issue; render(); document.querySelector(`[data-oid="${openWeigh}"] input`)?.focus(); return; }
  if (el("[data-closew]")) { openWeigh = null; render(); return; }
  if ((t = el("[data-confirm]"))) return patch(t.dataset.confirm, { issued: true, weights: draft[t.dataset.confirm] || {} });
  if ((t = el("[data-skip]"))) return patch(t.dataset.skip, { issued: true, weights: {} });
  if ((t = el("[data-unissue]"))) return patch(t.dataset.unissue, { issued: false });
  if ((t = el("[data-del]"))) {
    if (t.dataset.sure !== "1") { t.dataset.sure = "1"; t.textContent = "Точно удалить?"; setTimeout(() => { t.dataset.sure = ""; t.textContent = "Удалить"; }, 3000); return; }
    busy = true; t.disabled = true;
    try { await api(`/api/admin/orders/${t.dataset.del}`, { method: "DELETE" }); DATA.orders = DATA.orders.filter((o) => o.id !== t.dataset.del); render(); }
    catch { t.disabled = false; t.textContent = "Не удалось"; } finally { busy = false; }
  }
});

/* ---------- статистика ---------- */
async function loadStats() {
  $("stats").innerHTML = '<p class="empty">Загружаем…</p>';
  let s; try { s = await api("/api/admin/stats"); } catch (e) { $("stats").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  if (!s.weeks.length) { $("stats").innerHTML = '<div class="panel"><p class="empty">Статистика появится после первых заказов.</p></div>'; return; }
  const weeksTbl = `<div class="panel"><h4>По выходным</h4><div class="scroll"><table class="wk"><thead><tr><th>Выходные</th><th>Заказов</th><th>Выдано</th><th>Не забрали</th><th>Отменили</th><th>Форелей</th><th>Выручка</th></tr></thead><tbody>
    ${s.weeks.map((w) => `<tr><td>${wkLabel(w.weekend)}${w.weekend === s.current ? " · текущие" : ""}</td><td>${w.orders}</td><td>${w.issued}</td><td>${w.weekend < s.current ? w.noShow : "—"}</td><td>${w.cancelled}</td><td>${w.trout}</td><td>${w.revenue ? rub(w.revenue) : "—"}</td></tr>`).join("")}
    </tbody></table></div><p class="fine">Выручка считается по выданным заказам с указанным весом. «Не забрали» — заказы прошедших выходных без отметки о выдаче.</p></div>`;
  // точки: среднее за последние 4 недели и динамика к предыдущим 4
  const done = s.weeks.filter((w) => w.weekend < s.current), recent = done.slice(0, 4), prev = done.slice(4, 8);
  const avg = (ws, pid) => (ws.length ? ws.reduce((a, w) => a + (w.points[pid] || 0), 0) / ws.length : 0);
  const pts = Object.values(POINTS).map((p) => ({ p, a: avg(recent, p.id), b: prev.length ? avg(prev, p.id) : null })).sort((x, y) => y.a - x.a);
  if (!recent.length) pts.length = 0;
  const mx = Math.max(1, ...pts.map((x) => x.a));
  const ptsHtml = `<div class="panel"><h4>Точки: в среднем заказов за выходные${recent.length ? ` (прошедшие ${recent.length})` : ""}</h4>${recent.length ? "" : '<p class="empty">Появится после первых завершённых выходных.</p>'}
    ${pts.map(({ p, a, b }) => { const d = b === null ? "" : a - b; return `<div class="pbar"><span>${esc(p.name)} <span class="fine">· ${p.route.off ? "вс" : "сб"}, ${esc(p.route.sub)}</span></span><span class="t"><i style="width:${(a / mx) * 100}%"></i></span><span class="v ${d > 0.5 ? "up" : d < -0.5 ? "down" : ""}">${a.toFixed(1).replace(".", ",")}${d === "" ? "" : d > 0.5 ? " ↑" : d < -0.5 ? " ↓" : ""}</span></div>`; }).join("")}
    ${prev.length ? '<p class="fine">Стрелка показывает рост или падение по сравнению с четырьмя выходными до этого.</p>' : ""}</div>`;
  const ns = `<div class="panel"><h4>Не забирают заказы повторно</h4>${s.repeatNoShows.length ? `<ul class="olist">${s.repeatNoShows.map((x) => `<li style="grid-template-columns:minmax(0,1fr) auto"><span style="text-transform:capitalize">${esc(x.name)}</span><b class="num">${x.n} ${x.n < 5 ? "раза" : "раз"}</b></li>`).join("")}</ul><p class="fine">При выдаче такие покупатели помечаются значком «не забрал». Совпадение ищется по имени и фамилии.</p>` : '<p class="empty">Таких покупателей пока нет.</p>'}</div>`;
  $("stats").innerHTML = weeksTbl + ptsHtml + ns;
}

start();
