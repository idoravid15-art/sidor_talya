// Periscope Strategy · UI controller
import * as engine from './engine.js';
const { DEFAULT_CONFIG, fmt } = engine;
const MAX_TRAINERS = engine.MAX_TRAINERS || 5;
const LETTERS = ['א', 'ב', 'ג', 'ד', 'ה'];
import { availMap, DAY_NAMES, DAY_SHORT, typeColor, toMin, hhmm, rng, hoursTxt, esc, sessionName, trainerName, timeOptions } from './ui-common.js';
import { renderBoard, renderLegend } from './board.js';
import { exportPrint, exportPNG, exportExcel } from './exports.js';

const KEY = 'periscope-strategy.v1';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clone = o => JSON.parse(JSON.stringify(o));
const tfmt = m => { try { return fmt(m); } catch { return hhmm(m); } };

/* ---------------- state ---------------- */
function defaults() {
  return { config: clone(DEFAULT_CONFIG), step: 1, seed: 1, result: null, builtFor: null };
}
function merge(base, saved) {
  if (saved == null) return base;
  if (Array.isArray(base)) return Array.isArray(saved) ? saved : base;
  if (typeof base === 'object' && base) {
    const out = { ...base };
    for (const k of Object.keys(saved)) out[k] = k in base ? merge(base[k], saved[k]) : saved[k];
    return out;
  }
  return typeof saved === typeof base ? saved : base;
}
function load() {
  const st = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return st;
    const s = JSON.parse(raw);
    const cfg = merge(st.config, s.config || {});
    // types: keep default list/order, take saved user fields by id
    // types: keep default list/order, take saved user fields by id
    cfg.types = DEFAULT_CONFIG.types.map(t => {
      const sv = (s.config?.types || []).find(x => x.id === t.id) || {};
      const r = { ...t, ...pick(sv, ['hours', 'allowShort', 'duration', 'name', 'blocked']) };
      r.blocked = Array.isArray(r.blocked) ? r.blocked.filter(b => b && b.day != null && b.from && b.to) : [];
      return r;
    });
    cfg.trainers = migrateTrainers(s.config?.trainers);
    // "after" belongs to the manager: legacy auto mode (engine picked the trainer) -> Talya
    if (s.config?.after?.mode !== 'manual' || !cfg.trainers.some(t => t.id === cfg.after.trainerId)) cfg.after.trainerId = afterOwner({ ...cfg, after: { ...cfg.after, trainerId: null } });
    return { ...st, config: cfg, step: [1, 2, 3, 4].includes(s.step) ? s.step : 1, seed: s.seed || 1, result: s.result || null, builtFor: s.builtFor || null };
  } catch { return st; }
}
const LEGACY_T1 = 'מאמנת א';
const ALL_DAYS = [0, 1, 2, 3, 4];
function migrateTrainers(saved) {
  if (!Array.isArray(saved) || !saved.length) return clone(DEFAULT_CONFIG.trainers);
  const ids = new Set();
  return saved.slice(0, MAX_TRAINERS).map((t, i) => {
    const def = DEFAULT_CONFIG.trainers[i] || {};
    let id = typeof t?.id === 'string' && t.id ? t.id : def.id || `t${i + 1}`;
    while (ids.has(id)) id += 'x';
    ids.add(id);
    let name = typeof t?.name === 'string' && t.name.trim() ? t.name : def.name || `מאמנת ${i + 1}`;
    if (id === 't1' && name === LEGACY_T1) name = DEFAULT_CONFIG.trainers[0].name;
    // availability by day/hours; legacy `days` arrays become all-day entries
    const src = availMap(t || {}), availability = {};
    for (const [k, v] of Object.entries(src)) if (ALL_DAYS.includes(+k)) availability[+k] = v && v.from && v.to && toMin(v.from) < (toMin(v.to) || 1440) ? { from: v.from, to: v.to } : null;
    if (!Object.keys(availability).length) ALL_DAYS.forEach(d => (availability[d] = null));
    return { id, name, isManager: 'isManager' in (t || {}) ? !!t.isManager : id === 't1', availability };
  });
}
const afterOwner = c => engine.afterTrainerId ? engine.afterTrainerId(c) : (c.trainers.find(t => t.isManager) || c.trainers[0]).id;
const pick = (o, ks) => Object.fromEntries(ks.filter(k => k in o).map(k => [k, o[k]]));
let state = load();
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      flashSaved('נשמר');
    } catch { flashSaved('לא ניתן לשמור במכשיר זה'); }
  }, 250);
}
function flashSaved(t) {
  const el = $('#saveState'); el.textContent = t;
  clearTimeout(flashSaved.t); flashSaved.t = setTimeout(() => (el.textContent = ''), 1800);
}
const cfg = () => state.config;
const cfgKey = () => JSON.stringify(cfg());
function changed() { save(); renderCapacity(); renderStale(); }

/* ---------------- toast ---------------- */
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ---------------- stepper ---------------- */
function go(step, { push = true, focus = true } = {}) {
  state.step = step;
  $$('.screen').forEach(s => (s.hidden = +s.dataset.screen !== step));
  $$('.step').forEach(b => {
    const n = +b.dataset.step;
    if (n === step) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    b.classList.toggle('done', n < step);
  });
  if (push) try { history.pushState({ step }, '', '#step' + step); } catch {}
  if (step === 2) renderFixed();
  if (step === 3) renderSettings();
  if (step === 4) renderResult();
  if (focus) { window.scrollTo({ top: 0 }); $(`#h${step}`).setAttribute('tabindex', '-1'); $(`#h${step}`).focus({ preventScroll: true }); }
  save();
}

/* ---------------- step 1: requirements ---------------- */
function estimateCapacity(c) {
  const r = c.rules;
  const wS = r.weekStart ?? 600, wE = r.weekEnd ?? 6600, dMax = r.dailyMax ?? 480;
  let cap = 0;
  for (let d = 0; d < 5; d++) {
    const a = Math.max(d * 1440, wS), b = Math.min((d + 1) * 1440, wE);
    if (b > a) cap += Math.min(b - a, c.trainers.reduce((s, t) => {
      if (!(d in availMap(t))) return s;
      const r = availMap(t)[d], ra = d * 1440 + (r ? toMin(r.from) : 0), rb = d * 1440 + (r ? toMin(r.to) || 1440 : 1440);
      return s + Math.min(dMax, Math.max(0, Math.min(b, rb) - Math.max(a, ra)));
    }, 0));
  }
  cap -= r.cleaningMinutes ?? 60;
  cap -= seriesMinutes(c);
  cap -= 240; // one trainer's after evening
  cap -= (c.fixed || []).filter(f => !f.typeId).reduce((s, f) => s + (+f.duration || 0), 0);
  cap *= 0.9; // breaks between sessions
  return Math.max(0, Math.floor(cap / 30) * 30);
}
// precise estimate from the engine when it offers one (not part of the contract), cached by capacity-relevant config
const capCache = { key: null, val: null, pending: null };
function capacity(c) {
  if (typeof engine.estimateCapacity !== 'function') return estimateCapacity(c);
  const key = JSON.stringify({ t: c.trainers.map(t => [t.id, t.availability]), s: c.series, f: c.fixed, a: c.after, cl: c.cleaning, r: c.rules });
  if (capCache.key === key && capCache.val != null) return capCache.val;
  if (capCache.pending !== key) {
    capCache.pending = key;
    const run = () => {
      if (capCache.pending !== key) return;
      try { const v = engine.estimateCapacity(clone(c)); if (typeof v === 'number' && isFinite(v) && v > 0) { capCache.key = key; capCache.val = v; } } catch {}
      capCache.pending = null;
      if (capCache.key === key) renderCapacity();
    };
    (window.requestIdleCallback || (f => setTimeout(f, 60)))(run, { timeout: 800 });
  }
  return capCache.key === key ? capCache.val : estimateCapacity(c);
}
const seriesBlocks = c => (c.series?.enabled ? (engine.seriesSessions ? engine.seriesSessions(c) : []) : []);
const seriesMinutes = c => seriesBlocks(c).reduce((a, b) => a + (+b.duration || 0), 0);
function requiredMinutes(c) { return c.types.reduce((s, t) => s + Math.round((+t.hours || 0) * 60), 0); }

function renderTypes() {
  const grid = $('#typeGrid');
  grid.innerHTML = cfg().types.map((t, i) => {
    const c = typeColor(t.id, cfg().types);
    const canShort = (+t.duration || 0) > 90;
    const n = sessionsHint(t);
    return `<article class="panel type-card${t.hours ? '' : ' zero'}" data-i="${i}" aria-labelledby="tn-${t.id}">
      <div class="type-head">
        <span class="type-swatch" style="background:${c}" aria-hidden="true"></span>
        <h2 class="type-name" id="tn-${t.id}">${esc(t.name)}</h2>
        <span class="prio">עדיפות <b>${t.priority}</b></span>
      </div>
      <div class="hours">
        <button type="button" class="icon-btn" data-act="dec" aria-label="פחות חצי שעה, ${esc(t.name)}" ${t.hours <= 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg></button>
        <label class="hours-input"><input type="number" inputmode="decimal" min="0" max="99" step="0.5" value="${+t.hours || 0}" aria-label="שעות בשבוע, ${esc(t.name)}"><span>ש' בשבוע</span></label>
        <button type="button" class="icon-btn" data-act="inc" aria-label="עוד חצי שעה, ${esc(t.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
      </div>
      <div class="type-meta"><span>אימון של ${hoursTxt(t.duration)} ש'</span><span class="sess-hint">${n}</span></div>
      ${canShort ? `<label class="switch"><input type="checkbox" data-act="short" ${t.allowShort ? 'checked' : ''}><span class="switch-track" aria-hidden="true"></span><span>אפשר לקצר לאימון של 1.5 שעות</span></label>` : ''}
      <details class="cons"${openCons.has(t.id) ? ' open' : ''}><summary>אילוצים <span class="cons-badge${(t.blocked || []).length ? ' has' : ''}" aria-label="${(t.blocked || []).length} אילוצים">${(t.blocked || []).length}</span><span class="sr-only">: זמנים שבהם ${esc(t.name)} לא יכולים להתאמן</span></summary>
        <div class="cons-body">${consBody(t)}</div>
      </details>
    </article>`;
  }).join('');
}
const openCons = new Set();
const consText = b => {
  const all = b.from === b.to && b.from === '00:00';
  if (all) return `${DAY_NAMES[b.day]} · כל היום`;
  const next = toMin(b.to) <= toMin(b.from);
  return `${DAY_NAMES[b.day]} ${rng(toMin(b.from), toMin(b.to))}${next ? ' (עד למחרת)' : ''}`;
};
function consBody(t) {
  const list = t.blocked || [], times = timeOptions();
  const opt = (arr, v) => arr.map(x => `<option value="${x[0]}" ${String(x[0]) === String(v) ? 'selected' : ''}>${x[1]}</option>`).join('');
  return `<p class="hint">זמנים שבהם האוכלוסייה הזו לא יכולה להתאמן. אם "עד" מוקדם מ"מ-", הטווח נמשך למחרת.</p>
    ${list.length ? `<ul class="cons-list">${list.map((b, k) => `<li><span>${consText(b)}</span><button type="button" class="icon-btn" data-act="cdel" data-k="${k}" aria-label="מחיקת אילוץ: ${esc(consText(b))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></li>`).join('')}</ul>` : '<p class="hint">אין אילוצים.</p>'}
    <div class="cons-form">
      <label class="field"><span>יום</span><select data-c="day">${opt(DAY_NAMES.map((n, d) => [d, n]), 0)}</select></label>
      <label class="field"><span>מ-</span><select data-c="from">${opt(times.map(x => [x, x]), '08:00')}</select></label>
      <label class="field"><span>עד</span><select data-c="to">${opt(times.map(x => [x, x]), '12:00')}</select></label>
    </div>
    <div class="cons-actions">
      <label class="switch"><input type="checkbox" data-c="allday"><span class="switch-track" aria-hidden="true"></span><span>כל היום</span></label>
      <button type="button" class="btn btn-ghost btn-sm" data-act="cadd">הוספת אילוץ</button>
      ${list.length ? '<button type="button" class="btn btn-ghost btn-sm" data-act="cclear">ניקוי אילוצים</button>' : ''}
    </div>
    <p class="cons-err" role="alert"></p>`;
}
function renderCons(i, focusSel) {
  const t = cfg().types[i], card = $(`.type-card[data-i="${i}"]`);
  card.querySelector('.cons-body').innerHTML = consBody(t);
  const n = (t.blocked || []).length, badge = card.querySelector('.cons-badge');
  badge.textContent = n; badge.classList.toggle('has', n > 0); badge.setAttribute('aria-label', `${n} אילוצים`);
  if (focusSel) card.querySelector(focusSel)?.focus();
}
function consAction(i, act, el) {
  const t = cfg().types[i], card = $(`.type-card[data-i="${i}"]`);
  t.blocked ||= [];
  if (act === 'cadd') {
    const q = k => card.querySelector(`[data-c=${k}]`);
    const all = q('allday').checked, from = all ? '00:00' : q('from').value, to = all ? '00:00' : q('to').value;
    if (!all && from === to) { card.querySelector('.cons-err').textContent = 'שעת הסיום זהה להתחלה. ליום שלם סמני "כל היום".'; return; }
    const b = { day: +q('day').value, from, to };
    if (t.blocked.some(x => x.day === b.day && x.from === b.from && x.to === b.to)) { card.querySelector('.cons-err').textContent = 'האילוץ הזה כבר קיים.'; return; }
    t.blocked.push(b);
    t.blocked.sort((a, c) => a.day - c.day || toMin(a.from) - toMin(c.from));
    renderCons(i, '[data-act=cadd]'); changed(); toast(`נוסף אילוץ ל${t.name}: ${consText(b)}`);
  } else if (act === 'cdel') {
    t.blocked.splice(+el.dataset.k, 1);
    renderCons(i, '[data-act=cadd]'); changed();
  } else if (act === 'cclear') {
    t.blocked = [];
    renderCons(i, '[data-act=cadd]'); changed(); toast(`האילוצים של ${t.name} נוקו`);
  }
}
function sessionsHint(t) {
  const m = Math.round((+t.hours || 0) * 60);
  if (!m) return 'לא נדרש השבוע';
  const full = Math.floor(m / t.duration), rest = m - full * t.duration;
  if (!rest) return `≈ ${full} אימונים`;
  if (t.allowShort && rest % 90 === 0) return `≈ ${full} + ${rest / 90} מקוצרים`;
  return `≈ ${full + 1} אימונים`;
}
function setHours(i, h) {
  const t = cfg().types[i];
  t.hours = Math.max(0, Math.min(99, Math.round((+h || 0) * 2) / 2));
  const card = $(`.type-card[data-i="${i}"]`);
  card.querySelector('input[type=number]').value = t.hours;
  card.querySelector('[data-act=dec]').disabled = t.hours <= 0;
  card.querySelector('.sess-hint').textContent = sessionsHint(t);
  card.classList.toggle('zero', !t.hours);
  changed();
}
function bindTypes() {
  const grid = $('#typeGrid');
  grid.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b || b.type === 'checkbox') return;
    const i = +b.closest('.type-card').dataset.i, t = cfg().types[i];
    if (b.dataset.act === 'inc') setHours(i, (+t.hours || 0) + 0.5);
    if (b.dataset.act === 'dec') setHours(i, (+t.hours || 0) - 0.5);
    if (['cadd', 'cdel', 'cclear'].includes(b.dataset.act)) consAction(i, b.dataset.act, b);
  });
  grid.addEventListener('change', e => {
    const card = e.target.closest('.type-card'); if (!card) return;
    const i = +card.dataset.i;
    if (e.target.dataset.c === 'allday') { card.querySelectorAll('[data-c=from],[data-c=to]').forEach(s => (s.disabled = e.target.checked)); return; }
    if (e.target.dataset.c) { card.querySelector('.cons-err').textContent = ''; return; }
    if (e.target.type === 'number') setHours(i, e.target.value);
    if (e.target.dataset.act === 'short') { cfg().types[i].allowShort = e.target.checked; card.querySelector('.sess-hint').textContent = sessionsHint(cfg().types[i]); changed(); }
  });
}
function renderSeries() {
  const on = !!cfg().series?.enabled;
  $('#seriesOn').checked = on;
  $('.series-panel').classList.toggle('on', on);
}
function renderCapacity() {
  const req = requiredMinutes(cfg()), cap = capacity(cfg());
  const ratio = cap ? req / cap : 0;
  const level = ratio > 1 ? 'over' : ratio > 0.85 ? 'tight' : 'ok';
  const m = $('#capMeter');
  m.dataset.level = level;
  m.setAttribute('aria-valuemax', hoursTxt(cap)); m.setAttribute('aria-valuenow', hoursTxt(Math.min(req, cap)));
  m.setAttribute('aria-valuetext', `${hoursTxt(req)} שעות נדרשות מתוך כ-${hoursTxt(cap)}`);
  $('#capFill').style.width = Math.min(100, ratio * 100) + '%';
  const st = $('#capStatus'); st.dataset.level = level;
  st.textContent = { ok: '✓ יש מרווח', tight: '! צפוף', over: '✕ מעבר לקיבולת' }[level];
  $('#capText').innerHTML = req
    ? `נדרשות <strong>${hoursTxt(req)} ש'</strong> מתוך קיבולת משוערת של <strong>כ-${hoursTxt(cap)} ש'</strong> בשבוע${seriesMinutes(cfg()) ? ` (אחרי ${hoursTxt(seriesMinutes(cfg()))} ש' סדרות)` : ''}.` +
      (level === 'over' ? ' חלק לא ייכנס, והמנוע יוותר קודם על העדיפויות הנמוכות.' : level === 'tight' ? ' כנראה ייכנס, אבל ייתכנו אימונים בלילה או מקוצרים.' : '')
    : `עוד לא הוזנו שעות. קיבולת משוערת: <strong>כ-${hoursTxt(cap)} ש'</strong> בשבוע.`;
}

/* ---------------- step 2: fixed sessions ---------------- */
function fillSelect(sel, opts, value) {
  sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  if (value != null) sel.value = String(value);
}
const durOpts = () => Array.from({ length: 8 }, (_, i) => (i + 1) * 30).map(m => [m, m < 60 ? `${m} דק'` : `${hoursTxt(m)} ש' (${m} דק')`]);
function initFixedForm() {
  fillSelect($('#fxDay'), DAY_NAMES.map((n, i) => [i, n]), 0);
  fillSelect($('#fxStart'), timeOptions().map(t => [t, t]), '10:00');
  fillSelect($('#fxDur'), durOpts(), 120);
  const syncType = () => {
    const v = $('#fxType').value;
    $('#fxLabelWrap').hidden = v !== '';
    const t = cfg().types.find(t => t.id === v);
    if (t) $('#fxDur').value = String(t.duration);
  };
  $('#fxType').addEventListener('change', syncType);
  $('#fixedForm').addEventListener('submit', e => {
    e.preventDefault();
    const c = cfg(), err = $('#fxError');
    const day = +$('#fxDay').value, start = $('#fxStart').value, duration = +$('#fxDur').value;
    const typeId = $('#fxType').value || null, label = $('#fxLabel').value.trim();
    const abs = day * 1440 + toMin(start), end = abs + duration;
    const wS = c.rules.weekStart ?? 600, wE = c.rules.weekEnd ?? 6600;
    if (!typeId && !label) { err.textContent = 'צריך לבחור סוג אימון או לכתוב תווית.'; $('#fxLabel').focus(); return; }
    if (abs < wS || end > wE) { err.textContent = `השעה מחוץ לשבוע העבודה (ראשון ${tfmt(wS)} עד חמישי ${tfmt(wE)}).`; $('#fxStart').focus(); return; }
    const clash = c.fixed.find(f => { const s = f.day * 1440 + toMin(f.start); return abs < s + f.duration && s < end; });
    if (clash) { err.textContent = `חופף לאימון קבוע אחר (${DAY_NAMES[clash.day]} ${clash.start}).`; return; }
    const sclash = seriesBlocks(c).find(f => { const s = f.day * 1440 + toMin(f.start); return abs < s + f.duration && s < end; });
    if (sclash) { err.textContent = `חופף לבלוק סדרות (${DAY_NAMES[sclash.day]} ${rng(toMin(sclash.start), toMin(sclash.start) + sclash.duration)}).`; return; }
    err.textContent = '';
    c.fixed.push({ id: 'f' + Date.now().toString(36), typeId, label: typeId ? '' : label, day, start, duration, trainerId: $('#fxTrainer').value || null });
    $('#fxLabel').value = '';
    renderFixed(); changed();
    toast('האימון הקבוע נוסף');
  });
  $('#fixedList').addEventListener('click', e => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    cfg().fixed = cfg().fixed.filter(f => f.id !== b.dataset.del);
    renderFixed(); changed();
    toast('האימון הקבוע נמחק');
    $('#fixedForm button[type=submit]').focus();
  });
}
function renderFixed() {
  const c = cfg();
  const tv = $('#fxType').value, trv = $('#fxTrainer').value;
  fillSelect($('#fxType'), [...c.types.map(t => [t.id, t.name]), ['', 'אחר (תווית חופשית)']], tv || c.types[0]?.id);
  fillSelect($('#fxTrainer'), [['', 'כל אחת (המנוע יבחר)'], ...c.trainers.map(t => [t.id, t.name])], trv);
  $('#fxLabelWrap').hidden = $('#fxType').value !== '';
  const list = [...c.fixed].sort((a, b) => a.day - b.day || toMin(a.start) - toMin(b.start));
  $('#fixedCount').textContent = list.length ? `(${list.length})` : '';
  $('#fixedEmpty').hidden = list.length > 0;
  $('#fixedList').innerHTML = list.map(f => {
    const name = f.typeId ? (c.types.find(t => t.id === f.typeId)?.name || 'אימון') : f.label;
    const s = toMin(f.start);
    return `<li class="fixed-item" style="--c:${typeColor(f.typeId, c.types)}">
      <div class="fixed-when">${DAY_NAMES[f.day]}<small>${rng(s, s + f.duration)}</small></div>
      <div class="fixed-what"><b>${esc(name)}</b><small>${f.trainerId ? esc(trainerName(f.trainerId, c.trainers)) : 'כל אחת'} · ${hoursTxt(f.duration)} ש'</small></div>
      <button type="button" class="icon-btn" data-del="${esc(f.id)}" aria-label="מחיקה: ${esc(name)} ביום ${DAY_NAMES[f.day]} ${f.start}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </li>`;
  }).join('');
}

/* ---------------- step 3: settings ---------------- */
const ADV = [
  ['maxContinuous', 'אימון רציף מקסימלי (דק\')', 'num'],
  ['minBreak', 'הפסקה בין אימונים של אותה מאמנת (דק\')', 'num'],
  ['dailyMax', 'מכסה יומית למאמנת (דק\')', 'num'],
  ['dailyMaxSoft', 'מכסה יומית בחריגה (דק\')', 'num'],
  ['sleepMinutes', 'שינה רציפה בלילה (דק\')', 'num'],
  ['sleepWindowStart', 'חלון שינה: מ-', 'time'],
  ['sleepWindowEnd', 'חלון שינה: עד (למחרת)', 'time'],
  ['preferredStart', 'שעות מועדפות: מ-', 'time'],
  ['preferredEnd', 'שעות מועדפות: עד', 'time24'],
  ['cleaningMinutes', 'משך יש"פ + ניקיון (דק\')', 'num'],
  ['afterEnd', 'אפטר: סיום אימונים', 'time'],
  ['afterReturn', 'אפטר: חזרה למחרת', 'time'],
  ['thursdayWindow.start', 'חלון חמישי: התחלה', 'time'],
  ['thursdayWindow.duration', 'חלון חמישי: משך (דק\')', 'num'],
  ['thursdayWindow.tradeoffMinutes', 'חלון חמישי: נשבר רק אם מוסיף יותר מ- (דק\')', 'num'],
];
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); const t = ks.reduce((a, k) => (a[k] ??= {}), o); t[last] = v; };

function initSettings() {
  const list = $('#trainerList');
  list.addEventListener('input', e => {
    const i = +e.target.closest('[data-ti]')?.dataset.ti; if (e.target.dataset.act !== 'name' || isNaN(i)) return;
    const t = cfg().trainers[i];
    t.name = e.target.value.trim() || defaultName(i);
    $$('#afterTrainer option').forEach(o => { if (o.value === t.id) o.textContent = t.name; });
    changed();
  });
  list.addEventListener('change', e => {
    const i = +e.target.closest('[data-ti]')?.dataset.ti; if (e.target.dataset.day == null || isNaN(i)) return;
    const t = cfg().trainers[i], d = +e.target.dataset.day;
    const av = t.availability ||= availMap(t);
    if (!e.target.checked && Object.keys(av).length <= 1) { e.target.checked = true; $('#trainerHint').textContent = 'כל מאמנת צריכה לפחות יום זמינות אחד.'; return; }
    if (e.target.checked) av[d] = null; else delete av[d];
    $('#trainerHint').textContent = '';
    renderTrainers(`[data-ti="${i}"] [data-day="${d}"]`); changed();
  });
  list.addEventListener('change', e => {
    const row = e.target.closest('.hrs-row'); if (!row) return;
    const i = +e.target.closest('[data-ti]').dataset.ti, d = +row.dataset.d, t = cfg().trainers[i];
    const av = t.availability ||= availMap(t);
    if (e.target.dataset.h === 'mode') av[d] = e.target.value === 'range' ? { from: '08:00', to: '16:00' } : null;
    else {
      const from = row.querySelector('[data-h=from]').value, to = row.querySelector('[data-h=to]').value;
      if (toMin(from) >= (toMin(to) || 1440)) { $('#trainerHint').textContent = 'שעת הסיום צריכה להיות אחרי שעת ההתחלה.'; e.target.value = e.target.dataset.h === 'from' ? av[d].from : av[d].to; return; }
      av[d] = { from, to };
    }
    $('#trainerHint').textContent = '';
    renderTrainers(`[data-ti="${i}"] .hrs-row[data-d="${d}"] [data-h=${e.target.dataset.h}]`); changed();
  });
  list.addEventListener('click', e => {
    const b = e.target.closest('[data-act=del]'); if (!b) return;
    const c = cfg(), i = +b.closest('[data-ti]').dataset.ti, t = c.trainers[i];
    if (c.trainers.length <= 1) return;
    if (t.id === afterOwner(c)) { $('#trainerHint').textContent = `האפטר של ${t.name}. קודם להעביר את האפטר למאמנת אחרת.`; $('#afterTrainer').focus(); return; }
    c.trainers.splice(i, 1);
    c.fixed.forEach(f => { if (f.trainerId === t.id) f.trainerId = null; });
    $('#trainerHint').textContent = '';
    renderSettings(); changed(); toast(`${t.name} הוסרה`);
    $('#addTrainer').focus();
  });
  $('#addTrainer').addEventListener('click', () => {
    const c = cfg(); if (c.trainers.length >= MAX_TRAINERS) return;
    let n = c.trainers.length + 1; while (c.trainers.some(t => t.id === 't' + n)) n++;
    c.trainers.push({ id: 't' + n, name: defaultName(c.trainers.length), availability: { 0: null, 1: null, 2: null, 3: null, 4: null } });
    renderSettings(); changed();
    const inputs = $$('#trainerList input[data-act=name]'); inputs[inputs.length - 1]?.focus(); inputs[inputs.length - 1]?.select();
  });
  $$('input[name=afterMode]').forEach(r => r.addEventListener('change', e => {
    const a = cfg().after; a.mode = e.target.value;
    if (a.mode === 'manual') a.day ??= +$('#afterDay').value;
    syncModes(); changed();
  }));
  $$('input[name=cleanMode]').forEach(r => r.addEventListener('change', e => {
    const cl = cfg().cleaning; cl.mode = e.target.value;
    if (cl.mode === 'manual') { cl.day ??= +$('#cleanDay').value; cl.start ||= $('#cleanStart').value; }
    syncModes(); changed();
  }));
  $('#afterTrainer').addEventListener('change', e => { cfg().after.trainerId = e.target.value; $('#trainerHint').textContent = ''; renderTrainers(); changed(); });
  $('#afterDay').addEventListener('change', e => { cfg().after.day = +e.target.value; changed(); });
  $('#cleanDay').addEventListener('change', e => { cfg().cleaning.day = +e.target.value; changed(); });
  $('#cleanStart').addEventListener('change', e => { cfg().cleaning.start = e.target.value; changed(); });
  $('#thuEnabled').addEventListener('change', e => { cfg().rules.thursdayWindow.enabled = e.target.checked; changed(); });
  $('#advGrid').addEventListener('change', e => {
    const p = e.target.dataset.path; if (!p) return;
    let v = e.target.value;
    if (e.target.type === 'number') { v = Math.max(0, Math.round(+v || 0)); e.target.value = v; }
    setPath(cfg().rules, p, v); syncTexts(); changed();
  });
  $('#advReset').addEventListener('click', () => { cfg().rules = clone(DEFAULT_CONFIG.rules); renderSettings(); changed(); toast('החוקים חזרו לברירת המחדל'); });
}
function syncModes() {
  $('#afterManual').hidden = cfg().after.mode !== 'manual';
  $('#cleanManual').hidden = cfg().cleaning.mode !== 'manual';
}
function syncTexts() {
  const r = cfg().rules, tw = r.thursdayWindow || {};
  $('#afterEndTxt').textContent = r.afterEnd; $('#afterRetTxt').textContent = r.afterReturn;
  $('#thuTxt').textContent = `${tw.start}-${hhmm(toMin(tw.start) + (+tw.duration || 0))}`;
  $('#thuTradeTxt').textContent = tw.tradeoffMinutes;
}
const defaultName = i => (i === 0 ? DEFAULT_CONFIG.trainers[0].name : `מאמנת ${LETTERS[i] || i + 1}`);
function hoursRows(t) {
  const av = availMap(t), from = timeOptions(0, 1410), to = timeOptions(30, 1440);
  const opts = (arr, v) => arr.map(x => `<option ${x === v ? 'selected' : ''}>${x}</option>`).join('');
  return Object.keys(av).map(Number).filter(d => ALL_DAYS.includes(d)).sort().map(d => {
    const r = av[d], lbl = `${t.name}, ${DAY_NAMES[d]}`;
    return `<div class="hrs-row" data-d="${d}"><span class="hrs-day" aria-hidden="true">${DAY_NAMES[d]}</span>
      <select data-h="mode" aria-label="שעות זמינות: ${esc(lbl)}"><option value="all" ${r ? '' : 'selected'}>כל היום</option><option value="range" ${r ? 'selected' : ''}>שעות…</option></select>
      ${r ? `<span class="hrs-range"><select data-h="from" aria-label="מ-, ${esc(lbl)}">${opts(from, r.from)}</select><span class="dash" aria-hidden="true">–</span><select data-h="to" aria-label="עד, ${esc(lbl)}">${opts(to, r.to)}</select></span>` : ''}</div>`;
  }).join('');
}
function renderTrainers(focusSel) {
  const c = cfg(), owner = afterOwner(c), one = c.trainers.length <= 1;
  $('#trainerList').innerHTML = c.trainers.map((t, i) => {
    const days = Object.keys(availMap(t)).map(Number), isOwner = t.id === owner;
    return `<li class="trainer-row" data-ti="${i}">
      <div class="trainer-top">
        <label class="field"><span>מאמנת ${i + 1}${isOwner ? '<span class="trainer-badge">· האפטר שלה</span>' : ''}</span><input type="text" data-act="name" maxlength="20" autocomplete="off" value="${esc(t.name)}"></label>
        <button type="button" class="icon-btn" data-act="del" aria-label="הסרת ${esc(t.name)}" ${one ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>
      <fieldset class="day-checks"><legend>ימים זמינים</legend>
        ${ALL_DAYS.map(d => `<label class="day-check"><input type="checkbox" data-day="${d}" ${days.includes(d) ? 'checked' : ''} aria-label="${esc(t.name)} זמינה ביום ${DAY_NAMES[d]}"><span aria-hidden="true">${DAY_SHORT[d]}</span></label>`).join('')}
      </fieldset>
      <div class="hrs" role="group" aria-label="שעות זמינות: ${esc(t.name)}">${hoursRows(t)}</div></li>`;
  }).join('');
  if (typeof focusSel === 'string') $(focusSel)?.focus();
  const add = $('#addTrainer');
  add.disabled = c.trainers.length >= MAX_TRAINERS;
  add.title = add.disabled ? `עד ${MAX_TRAINERS} מאמנות` : '';
}
function renderSettings() {
  const c = cfg();
  c.after.trainerId = afterOwner(c);
  renderTrainers();
  $(`input[name=afterMode][value=${c.after.mode}]`).checked = true;
  $(`input[name=cleanMode][value=${c.cleaning.mode}]`).checked = true;
  fillSelect($('#afterTrainer'), c.trainers.map(t => [t.id, t.name]), c.after.trainerId);
  fillSelect($('#afterDay'), DAY_NAMES.slice(0, 4).map((n, i) => [i, n]), c.after.day ?? 0);
  fillSelect($('#cleanDay'), DAY_NAMES.map((n, i) => [i, n]), c.cleaning.day ?? 0);
  fillSelect($('#cleanStart'), timeOptions().map(t => [t, t]), c.cleaning.start || '12:00');
  $('#thuEnabled').checked = !!c.rules.thursdayWindow?.enabled;
  const times = timeOptions(), times24 = timeOptions(0, 1440);
  $('#advGrid').innerHTML = ADV.map(([p, label, kind]) => {
    const v = getPath(c.rules, p); const id = 'adv-' + p.replace('.', '-');
    if (kind === 'num') return `<label class="field" for="${id}"><span>${esc(label)}</span><input type="number" id="${id}" data-path="${p}" min="0" step="30" inputmode="numeric" value="${esc(v)}"></label>`;
    const opts = (kind === 'time24' ? times24 : times).map(t => `<option ${t === v ? 'selected' : ''}>${t}</option>`).join('');
    return `<label class="field" for="${id}"><span>${esc(label)}</span><select id="${id}" data-path="${p}">${opts}</select></label>`;
  }).join('');
  syncModes(); syncTexts();
}

/* ---------------- step 4: build & result ---------------- */
let worker = null, building = false, rafId = 0;
const BUDGET = 2500;
function setProgress(p) {
  const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
  $('#scanPct').textContent = pct + '%';
  $('#scanFill').style.width = pct + '%';
}
function build({ fresh = false } = {}) {
  if (building) return;
  building = true;
  if (fresh) state.seed = (Math.floor(Math.random() * 1e9) >>> 0) || 1;
  const config = clone(cfg());
  const key = cfgKey();
  $('#scan').hidden = false; $('#result').hidden = true; $('#emptyState').hidden = true;
  $('#buildBtn').disabled = true; $$('#exportGroup .btn').forEach(b => (b.disabled = true));
  $('#buildStatus').textContent = 'בונה לו"ז, נא להמתין…';
  setProgress(0);
  const subs = ['מסדרת את האימונים לפי עדיפות', 'מתאימה שעות שינה ומנוחה', 'מאזנת עומס בין המאמנות', 'מחפשת שיפורים אחרונים'];
  const t0 = performance.now(); let reported = 0;
  const tick = () => {
    const el = performance.now() - t0;
    const p = Math.max(reported, Math.min(0.95, el / (BUDGET + 400)));
    setProgress(p);
    $('#scanSub').textContent = subs[Math.min(subs.length - 1, Math.floor(p * subs.length))];
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
  const MIN_SCAN = 1400; // let the sweep be seen, even when the engine is fast
  const finish = (err, result) => {
    const wait = MIN_SCAN - (performance.now() - t0);
    if (!err && wait > 0) { reported = 1; setTimeout(() => finish(err, result), wait); return; }
    cancelAnimationFrame(rafId); clearTimeout(guard);
    try { worker && worker.terminate(); } catch {}
    worker = null; building = false;
    $('#buildBtn').disabled = false; $('#scan').hidden = true;
    if (err) {
      $('#buildStatus').textContent = 'הבנייה נכשלה';
      renderResult({ error: err });
      return;
    }
    setProgress(1);
    state.result = result; state.builtFor = key;
    save(); renderResult();
    const sm = result.summary || {};
    $('#buildStatus').textContent = `הלו"ז מוכן: ${hoursTxt(sm.totalMinutes || 0)} שעות אימון שובצו.`;
    toast('הלו"ז מוכן');
  };
  const guard = setTimeout(() => finish('הבנייה לקחה יותר מדי זמן. נסי שוב.'), BUDGET + 15000);
  try {
    worker = new Worker('js/engine.worker.js', { type: 'module' });
  } catch (e) { finish('לא ניתן להפעיל את מנוע השיבוץ בדפדפן זה.'); return; }
  worker.onmessage = ({ data }) => {
    if (!data) return;
    if (data.type === 'progress') {
      const p = data.pct != null ? data.pct / 100 : (data.progress ?? data.fraction ?? (data.elapsed != null ? data.elapsed / BUDGET : null));
      if (typeof p === 'number' && isFinite(p)) reported = Math.max(reported, Math.min(0.97, p));
    } else if (data.type === 'done') {
      finish(null, data.result ?? data);
    } else if (data.type === 'error') {
      finish(data.message || 'שגיאה במנוע השיבוץ');
    }
  };
  worker.onerror = e => { e.preventDefault?.(); finish('שגיאה במנוע השיבוץ' + (e.message ? `: ${e.message}` : '')); };
  worker.postMessage({ config, opts: { timeBudgetMs: BUDGET, seed: state.seed } });
}

function renderStale() {
  const head = $('#screen-4 .result-head');
  let el = $('#stale');
  const stale = state.result && state.builtFor && state.builtFor !== cfgKey();
  if (stale && !el) {
    el = document.createElement('p'); el.id = 'stale'; el.className = 'stale';
    el.innerHTML = '<span aria-hidden="true">⟳</span> הנתונים השתנו מאז הבנייה האחרונה. לחצי "בנה מחדש" כדי לעדכן.';
    head.after(el);
  } else if (!stale && el) el.remove();
}

function ring(pct) {
  const r = 52, C = 2 * Math.PI * r, v = Math.max(0, Math.min(1, pct));
  const teeth = Array.from({ length: 24 }, (_, i) => `<rect x="68" y="2" width="4" height="8" rx="1" transform="rotate(${i * 15} 70 70)"/>`).join('');
  return `<svg viewBox="0 0 140 140" role="img" aria-label="ניצול ${Math.round(v * 100)} אחוז">
    <g fill="#3e5a70">${teeth}</g>
    <circle class="ring-bg" cx="70" cy="70" r="${r}" fill="none" stroke="#15212b" stroke-width="12"/>
    <circle cx="70" cy="70" r="${r}" fill="none" stroke="#f0962e" stroke-width="12" stroke-dasharray="${C * v} ${C}" transform="rotate(-90 70 70)" stroke-linecap="butt"/>
    <circle cx="70" cy="70" r="40" fill="none" stroke="#5aa7ef" stroke-opacity=".25"/>
    <path d="M70 26v10M70 104v10M26 70h10M104 70h10" stroke="#5aa7ef" stroke-opacity=".5"/>
    <text x="70" y="78" text-anchor="middle" class="util-num">${Math.round(v * 100)}%</text></svg>`;
}

function renderResult(opts = {}) {
  const r = state.result, c = cfg();
  $('#buildLabel').textContent = r ? 'בנה מחדש' : 'בנה לו"ז';
  $('#scan').hidden = !building;
  if (opts.error) {
    $('#result').hidden = !r; $('#emptyState').hidden = !!r;
    $('#resultLead').textContent = opts.error;
    toast(opts.error);
    return;
  }
  if (!r) {
    $('#result').hidden = true; $('#emptyState').hidden = building;
    $('#resultLead').textContent = 'לחצי "בנה לו"ז" כדי לקבל לוח שבועי.';
    return;
  }
  $('#emptyState').hidden = true; $('#result').hidden = building;
  $$('#exportGroup .btn').forEach(b => (b.disabled = false));
  const sm = r.summary || {};
  const pt = Object.values(sm.perType || {});
  const req = pt.reduce((a, p) => a + (p.requested || 0), 0), got = pt.reduce((a, p) => a + Math.min(p.scheduled || 0, p.requested || 0), 0);
  $('#resultLead').textContent = (req ? `שובצו ${hoursTxt(got)} מתוך ${hoursTxt(req)} ש' נדרשות` : `שובצו ${hoursTxt(sm.totalMinutes || 0)} ש' אימון`) + ` · ניצול ${Math.round((sm.utilization || 0) * 100)}%`;

  const loads = c.trainers.map(t => {
    const p = sm.perTrainer?.[t.id];
    const av = availMap(t), days = Object.keys(av).length, partial = days < 5 || Object.values(av).some(Boolean);
    return [t.name, p?.minutes ?? (sm.perTrainerDay?.[t.id] || []).reduce((a, b) => a + b, 0), partial ? (p?.availableMinutes != null ? `${hoursTxt(p.availableMinutes)} ש' זמינות` : `${days} ימים`) : ''];
  });
  const mins = loads.map(l => l[1]);
  const prop = sm.balance?.proportional ?? loads.some(l => l[2]);
  const diff = sm.balance?.diffMinutes ?? (mins.length > 1 ? Math.max(...mins) - Math.min(...mins) : 0);
  const balanced = sm.balance ? sm.balance.balanced : diff <= 30;
  const dTxt = diff ? ` · ${prop ? 'סטייה מהחלק היחסי' : 'הפרש'} ${diff} דק'` : '';
  const balTxt = loads.length < 2 ? '' : balanced
    ? `<span class="balance ok">✓ מאוזן${prop ? ' ביחס לשעות הזמינות' : ''}${dTxt}</span>`
    : `<span class="balance off">! לא מאוזן${dTxt}</span>`;
  $('#util').innerHTML = ring(sm.utilization || 0) + `<div><p class="util-sub">${hoursTxt(sm.totalMinutes || 0)} ש' אימון מתוך ${hoursTxt(sm.capacityMinutes || 0)} ש' זמינות</p>
    <ul class="trainer-load" aria-label="שעות שבועיות לכל מאמנת">${loads.map(([n, m, d]) => `<li><span>${esc(n)}${d ? `<small>(${esc(d)})</small>` : ''}</span><b>${hoursTxt(m)} ש'</b></li>`).join('')}</ul>${balTxt}</div>`;

  $('#gauges').innerHTML = c.types.map(t => {
    const p = sm.perType?.[t.id] || { requested: Math.round(t.hours * 60), scheduled: 0 };
    const none = !p.requested;
    const full = p.scheduled >= p.requested;
    const pct = p.requested ? Math.min(100, (p.scheduled / p.requested) * 100) : 0;
    const st = none ? '<span class="st">לא נדרש</span>' : full ? '<span class="st st-ok">✓ מלא</span>' : `<span class="st st-short">חסרות ${hoursTxt(p.requested - p.scheduled)} ש'</span>`;
    return `<li class="gauge-row${none ? ' none' : ''}" style="--c:${typeColor(t.id, c.types)}">
      <span class="gauge-name"><span class="type-swatch" style="background:${typeColor(t.id, c.types)}" aria-hidden="true"></span>${esc(t.name)}</span>
      <span class="gauge-val">${hoursTxt(p.scheduled)} / ${hoursTxt(p.requested)} ש' ${st}</span>
      <span class="gauge-bar" aria-hidden="true"><i style="width:${pct}%"></i></span></li>`;
  }).join('') + (sm.seriesMinutes ? `<li class="gauge-row" style="--c:${typeColor('series')}">
      <span class="gauge-name"><span class="type-swatch" style="background:${typeColor('series')}" aria-hidden="true"></span>סדרות</span>
      <span class="gauge-val">${hoursTxt(sm.seriesMinutes)} ש' <span class="st">בלוקים קבועים, לא נספר בדרישות</span></span>
      <span class="gauge-bar" aria-hidden="true"><i style="width:100%"></i></span></li>` : '');

  const items = [
    ...(r.violations || []).map(v => `<li class="e"><span class="ico" aria-hidden="true">✕</span><span><span class="sr-only">שגיאה: </span>${esc(v.message || v.code || v)}</span></li>`),
    ...(r.warnings || []).map(w => `<li class="w"><span class="ico" aria-hidden="true">!</span><span><span class="sr-only">הערה: </span>${esc(w)}</span></li>`),
  ];
  if (r.after) items.push(`<li class="ok"><span class="ico" aria-hidden="true">i</span><span>אפטר: ${esc(trainerName(r.after.trainerId, c.trainers))}, ${DAY_NAMES[r.after.day] ?? ''} מ-${tfmt(r.after.start)}</span></li>`);
  if (r.cleaning) items.push(`<li class="ok"><span class="ico" aria-hidden="true">i</span><span>יש"פ + ניקיון: ${DAY_NAMES[Math.floor(r.cleaning.start / 1440)] ?? ''} ${rng(r.cleaning.start, r.cleaning.end)}</span></li>`);
  if (!(r.warnings || []).length && !(r.violations || []).length) items.unshift('<li class="ok"><span class="ico" aria-hidden="true">✓</span><span>הכל נכנס בלי פשרות. אין הערות.</span></li>');
  $('#warnings').innerHTML = items.join('');

  renderLegend($('#legend'), c);
  renderBoard($('#board'), $('#dayTabs'), r, c);
  renderStale();
}

/* ---------------- init ---------------- */
function init() {
  renderTypes(); bindTypes(); renderCapacity(); renderSeries();
  $('#typeGrid').addEventListener('toggle', e => {
    const card = e.target.closest?.('.type-card'); if (!card || !e.target.matches('details.cons')) return;
    const id = cfg().types[+card.dataset.i].id; e.target.open ? openCons.add(id) : openCons.delete(id);
  }, true);
  $('#seriesOn').addEventListener('change', e => {
    cfg().series = { ...(cfg().series || {}), enabled: e.target.checked };
    renderSeries(); changed(); toast(e.target.checked ? 'תקופת סדרות הופעלה' : 'תקופת סדרות כובתה');
  });
  initFixedForm(); initSettings();
  $$('.step').forEach(b => b.addEventListener('click', () => go(+b.dataset.step)));
  $$('[data-go]').forEach(b => b.addEventListener('click', () => {
    go(+b.dataset.go);
    if (b.hasAttribute('data-build')) build({ fresh: !!state.result });
  }));
  $('#buildBtn').addEventListener('click', () => build({ fresh: !!state.result }));
  $('#printBtn').addEventListener('click', exportPrint);
  $('#pngBtn').addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true;
    try { const r = await exportPNG(state.result, cfg()); if (r === 'downloaded') toast('התמונה נשמרה'); }
    catch { toast('יצירת התמונה נכשלה'); } finally { b.disabled = false; }
  });
  $('#xlsxBtn').addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true; toast('מכינה קובץ…');
    try { const k = await exportExcel(state.result, cfg()); toast(k === 'xlsx' ? 'קובץ אקסל ירד' : 'אין חיבור לאקסל, ירד קובץ CSV שנפתח באקסל'); }
    catch { toast('הייצוא נכשל'); } finally { b.disabled = false; }
  });
  $('#resetBtn').addEventListener('click', () => {
    const d = $('#confirmDlg');
    if (typeof d.showModal !== 'function') { if (confirm('לאפס הכל?')) doReset(); return; }
    d.returnValue = ''; d.showModal();
    d.addEventListener('close', () => { if (d.returnValue === 'ok') doReset(); }, { once: true });
  });
  window.addEventListener('popstate', e => go(e.state?.step || 1, { push: false }));
  const fromHash = +(location.hash.match(/^#step([1-4])$/)?.[1] || 0);
  const start = fromHash || state.step || 1;
  try { history.replaceState({ step: start }, '', '#step' + start); } catch {}
  go(start, { push: false, focus: false });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
function doReset() {
  try { localStorage.removeItem(KEY); } catch {}
  state = defaults();
  renderTypes(); renderSeries(); renderCapacity(); renderFixed(); renderSettings();
  $('#board').innerHTML = ''; $('#stale')?.remove();
  go(1); toast('הכל אופס לברירת המחדל');
}
init();
