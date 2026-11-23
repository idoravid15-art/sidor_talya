// Periscope Strategy · UI controller
import * as engine from './engine.js';
const { DEFAULT_CONFIG, fmt } = engine;
import { DAY_NAMES, typeColor, toMin, hhmm, rng, hoursTxt, esc, sessionName, trainerName, timeOptions } from './ui-common.js';
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
    cfg.types = DEFAULT_CONFIG.types.map(t => {
      const sv = (s.config?.types || []).find(x => x.id === t.id) || {};
      return { ...t, ...pick(sv, ['hours', 'allowShort', 'duration', 'name']) };
    });
    if (!Array.isArray(cfg.trainers) || cfg.trainers.length !== DEFAULT_CONFIG.trainers.length) cfg.trainers = clone(DEFAULT_CONFIG.trainers);
    return { ...st, config: cfg, step: [1, 2, 3, 4].includes(s.step) ? s.step : 1, seed: s.seed || 1, result: s.result || null, builtFor: s.builtFor || null };
  } catch { return st; }
}
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
  const r = c.rules, n = c.trainers.length;
  const wS = r.weekStart ?? 600, wE = r.weekEnd ?? 6600, dMax = r.dailyMax ?? 480;
  let cap = 0;
  for (let d = 0; d < 5; d++) {
    const a = Math.max(d * 1440, wS), b = Math.min((d + 1) * 1440, wE);
    if (b > a) cap += Math.min(b - a, n * dMax);
  }
  cap -= r.cleaningMinutes ?? 60;
  cap -= 240; // one trainer's after evening
  cap -= (c.fixed || []).filter(f => !f.typeId).reduce((s, f) => s + (+f.duration || 0), 0);
  cap *= 0.9; // breaks between sessions
  return Math.max(0, Math.floor(cap / 30) * 30);
}
// precise estimate from the engine when it offers one (not part of the contract), cached by capacity-relevant config
const capCache = { key: null, val: null, pending: null };
function capacity(c) {
  if (typeof engine.estimateCapacity !== 'function') return estimateCapacity(c);
  const key = JSON.stringify({ t: c.trainers.length, f: c.fixed, a: c.after, cl: c.cleaning, r: c.rules });
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
  return capCache.val ?? estimateCapacity(c);
}
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
    </article>`;
  }).join('');
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
  });
  grid.addEventListener('change', e => {
    const card = e.target.closest('.type-card'); if (!card) return;
    const i = +card.dataset.i;
    if (e.target.type === 'number') setHours(i, e.target.value);
    if (e.target.dataset.act === 'short') { cfg().types[i].allowShort = e.target.checked; card.querySelector('.sess-hint').textContent = sessionsHint(cfg().types[i]); changed(); }
  });
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
    ? `נדרשות <strong>${hoursTxt(req)} ש'</strong> מתוך קיבולת משוערת של <strong>כ-${hoursTxt(cap)} ש'</strong> בשבוע.` +
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
  ['#tName0', '#tName1'].forEach((sel, i) => $(sel).addEventListener('input', e => {
    cfg().trainers[i].name = e.target.value.trim() || DEFAULT_CONFIG.trainers[i].name; changed();
  }));
  $$('input[name=afterMode]').forEach(r => r.addEventListener('change', e => {
    const a = cfg().after; a.mode = e.target.value;
    if (a.mode === 'manual') { a.trainerId ||= $('#afterTrainer').value; a.day ??= +$('#afterDay').value; }
    syncModes(); changed();
  }));
  $$('input[name=cleanMode]').forEach(r => r.addEventListener('change', e => {
    const cl = cfg().cleaning; cl.mode = e.target.value;
    if (cl.mode === 'manual') { cl.day ??= +$('#cleanDay').value; cl.start ||= $('#cleanStart').value; }
    syncModes(); changed();
  }));
  $('#afterTrainer').addEventListener('change', e => { cfg().after.trainerId = e.target.value; changed(); });
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
function renderSettings() {
  const c = cfg();
  $('#tName0').value = c.trainers[0].name; $('#tName1').value = c.trainers[1].name;
  $(`input[name=afterMode][value=${c.after.mode}]`).checked = true;
  $(`input[name=cleanMode][value=${c.cleaning.mode}]`).checked = true;
  fillSelect($('#afterTrainer'), c.trainers.map(t => [t.id, t.name]), c.after.trainerId || c.trainers[0].id);
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

  const loads = c.trainers.map(t => [t.name, (sm.perTrainerDay?.[t.id] || []).reduce((a, b) => a + b, 0)]);
  $('#util').innerHTML = ring(sm.utilization || 0) + `<div><p class="util-sub">${hoursTxt(sm.totalMinutes || 0)} ש' אימון מתוך ${hoursTxt(sm.capacityMinutes || 0)} ש' זמינות</p>
    <ul class="trainer-load" aria-label="עומס מאמנות">${loads.map(([n, m]) => `<li><span>${esc(n)}</span><b>${hoursTxt(m)} ש'</b></li>`).join('')}</ul></div>`;

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
  }).join('');

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
  renderTypes(); bindTypes(); renderCapacity();
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
  renderTypes(); renderCapacity(); renderFixed(); renderSettings();
  $('#board').innerHTML = ''; $('#stale')?.remove();
  go(1); toast('הכל אופס לברירת המחדל');
}
init();
