// Periscope Strategy: weekly scheduling engine (pure, no DOM, no dependencies).
// All times are absolute minutes from Sunday 00:00. Day d starts at d*1440.

export const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

export const DEFAULT_CONFIG = {
  trainers: [
    { id: 't1', name: 'טליה', isManager: true, availability: { 0: null, 1: null, 2: null, 3: null, 4: null } },
    { id: 't2', name: 'מאמנת ב', availability: { 0: null, 1: null, 2: null, 3: null, 4: null } },
  ],
  types: [
    { id: 'maamanot', name: 'מאמנות', priority: 1, hours: 0, duration: 120, allowShort: true },
    { id: 'kamas', name: 'קמ"ס', priority: 2, hours: 0, duration: 120, allowShort: true },
    { id: 'cadets2', name: 'צוערים רמה 2', priority: 3, hours: 0, duration: 120, allowShort: true },
    { id: 'officersQual', name: 'כשירויות קצינים', priority: 4, hours: 0, duration: 90, allowShort: false },
    { id: 'cadetsQual', name: 'כשירויות צוערים', priority: 5, hours: 0, duration: 90, allowShort: false },
  ],
  fixed: [],
  // "תקופת סדרות": long fixed blocks placed before everything else (exception to maxContinuous only)
  series: {
    enabled: false,
    blocks: [
      { day: 0, start: '18:00', duration: 240 },
      { day: 1, start: '06:00', duration: 180 }, { day: 1, start: '18:00', duration: 240 },
      { day: 2, start: '06:00', duration: 180 }, { day: 2, start: '18:00', duration: 240 },
      { day: 3, start: '06:00', duration: 180 }, { day: 3, start: '18:00', duration: 240 },
      { day: 4, start: '06:00', duration: 180 },
    ],
  },
  after: { mode: 'auto', trainerId: 't1', day: null }, // trainer is fixed (the manager); mode picks the day
  cleaning: { mode: 'auto', day: null, start: null },
  rules: {
    weekStart: 600, weekEnd: 6600, slot: 30, maxContinuous: 120, minBreak: 30,
    sleepMinutes: 480, sleepWindowStart: '20:00', sleepWindowEnd: '12:00',
    dailyMax: 480, dailyMaxSoft: 510, preferredStart: '06:00', preferredEnd: '24:00',
    cleaningMinutes: 60,
    thursdayWindow: { enabled: true, day: 4, start: '12:00', duration: 30, tradeoffMinutes: 30 },
    afterEnd: '17:00', afterReturn: '10:30',
  },
};

const SHORT_MIN = 90;
export const SERIES_TYPE = 'series';
export const SERIES_NAME = 'סדרות';
export const MAX_TRAINERS = 5;
const ALL_DAYS = [0, 1, 2, 3, 4];

// ---------- helpers ----------
export function parseHM(s) {
  if (typeof s === 'number') return s;
  if (s == null || s === '') return 0;
  const [h, m] = String(s).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
export function fmt(min) {
  const t = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60), m = t % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
export function dayOf(min) {
  return Math.max(0, Math.min(4, Math.floor(min / 1440)));
}
const dayName = (min) => DAY_NAMES[Math.max(0, Math.min(6, Math.floor(min / 1440)))];
const when = (min) => `${dayName(min)} ${fmt(min)}`;
const hoursStr = (min) => {
  const h = min / 60;
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
};

function mulberry32(a) {
  a = (a >>> 0) || 0x9e3779b9;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function clone(o) { return JSON.parse(JSON.stringify(o)); }

export function normalizeConfig(config = {}) {
  const d = clone(DEFAULT_CONFIG);
  const c = config ? clone(config) : {};
  const rules = { ...d.rules, ...(c.rules || {}) };
  rules.thursdayWindow = { ...d.rules.thursdayWindow, ...((c.rules && c.rules.thursdayWindow) || {}) };
  const trainers = (c.trainers && c.trainers.length ? c.trainers : d.trainers).slice(0, MAX_TRAINERS)
    .map((t, i) => ({
      id: t.id ?? `t${i + 1}`, name: t.name ?? `מאמנת ${i + 1}`, isManager: !!t.isManager,
      availability: normAvailability(t),
    })).map((t) => ({ ...t, days: Object.keys(t.availability).map(Number).sort() }));
  const after = { ...d.after, ...(c.after || {}) };
  after.trainerId = afterTrainerId({ trainers, after });
  const types = (c.types && c.types.length ? c.types : d.types).map((t, i) => {
    const base = d.types.find((x) => x.id === t.id) || {};
    const r = { ...base, ...t };
    r.priority = Number(r.priority ?? i + 1);
    r.hours = Math.max(0, Number(r.hours) || 0);
    r.duration = Number(r.duration) || 120;
    r.allowShort = !!r.allowShort;
    r.name = r.name ?? r.id;
    r.blocked = Array.isArray(r.blocked) ? r.blocked.filter((b) => b && b.day != null && b.from != null && b.to != null) : [];
    return r;
  });
  return {
    trainers,
    types,
    fixed: Array.isArray(c.fixed) ? c.fixed : [],
    series: {
      enabled: !!(c.series && c.series.enabled),
      blocks: (c.series && Array.isArray(c.series.blocks) ? c.series.blocks : d.series.blocks)
        .map((b) => ({ day: Number(b.day) || 0, start: b.start, duration: Number(b.duration) || 0 })).filter((b) => b.duration > 0),
    },
    after,
    cleaning: { ...d.cleaning, ...(c.cleaning || {}) },
    rules,
  };
}

// a type's weekly constraint {day, from, to} as absolute [start, end); to <= from means next day ("כל היום" = 00:00-00:00)
export function blockedRange(b) {
  const a = Number(b.day) * 1440 + parseHM(b.from);
  let e = Number(b.day) * 1440 + parseHM(b.to);
  if (e <= a) e += 1440;
  return [a, e];
}

// series blocks as fixed sessions with no trainer (the engine picks one per block)
export function seriesSessions(config) {
  const blocks = (config.series && config.series.blocks) || DEFAULT_CONFIG.series.blocks;
  return blocks.map((b) => ({
    id: `series-${b.day}-${String(b.start).replace(':', '')}`, typeId: null, label: SERIES_NAME,
    day: b.day, start: b.start, duration: b.duration, trainerId: null, series: true,
  }));
}

// the trainer who always gets the "after": configured one, else the manager, else the first
export function afterTrainerId(config) {
  const T = (config && config.trainers) || [];
  const want = config && config.after && config.after.trainerId;
  if (want != null && T.some((t) => t.id === want)) return want;
  return (T.find((t) => t.isManager) || T[0] || {}).id ?? null;
}
// trainer availability: { [day]: null (all day) | {from, to} } ; legacy `days` array → all-day entries
export function normAvailability(t) {
  const out = {};
  const okDay = (d) => Number.isInteger(d) && d >= 0 && d <= 6;
  if (t && t.availability && typeof t.availability === 'object') {
    for (const [k, v] of Object.entries(t.availability)) {
      const d = Number(k);
      if (!okDay(d)) continue;
      if (v && v.from != null && v.to != null) {
        const a = parseHM(v.from), b = parseHM(v.to) || 1440;
        out[d] = a === 0 && b >= 1440 ? null : b > a ? { from: v.from, to: b >= 1440 ? '24:00' : v.to } : null;
      } else out[d] = null;
    }
    return out;
  }
  const days = t && Array.isArray(t.days) ? t.days.map(Number).filter(okDay) : ALL_DAYS;
  for (const d of days) out[d] = null;
  return out;
}
const availMap = (t) => (t.availability && typeof t.availability === 'object' ? t.availability : normAvailability(t));
const availOn = (t, d) => d in availMap(t);
// [start, end) minutes-of-day the trainer may teach on day d, or null when unavailable
function dayRange(t, d) {
  const m = availMap(t);
  if (!(d in m)) return null;
  const r = m[d];
  return r ? [parseHM(r.from), parseHM(r.to) || 1440] : [0, 1440];
}

// ---------- context ----------
function buildCtx(cfg) {
  const R = cfg.rules;
  const slot = R.slot, ws = R.weekStart, we = R.weekEnd;
  const N = Math.max(1, Math.floor((we - ws) / slot));
  const T = cfg.trainers.length;
  const brk = Math.max(0, Math.ceil(R.minBreak / slot));
  const maxK = Math.max(1, Math.floor(R.maxContinuous / slot));
  const pS = parseHM(R.preferredStart), pE = parseHM(R.preferredEnd);
  const D = Math.floor((we - 1) / 1440) + 1;
  const off = new Uint8Array(N), dayOfSlot = new Uint8Array(N);
  for (let s = 0; s < N; s++) {
    const t = ws + s * slot, tod = t % 1440;
    off[s] = tod < pS || tod + slot > pE ? 1 : 0;
    dayOfSlot[s] = Math.floor(t / 1440);
  }
  const toSlot = (m) => Math.floor((m - ws) / slot);
  const toSlotCeil = (m) => Math.ceil((m - ws) / slot);
  const trIdx = (id) => cfg.trainers.findIndex((t) => t.id === id);

  // types sorted by priority (stable)
  const order = cfg.types.map((t, i) => i).sort((a, b) => cfg.types[a].priority - cfg.types[b].priority || a - b);
  const prios = [...new Set(order.map((i) => cfg.types[i].priority))];
  const types = order.map((i) => {
    const t = cfg.types[i];
    const defK = Math.min(maxK, Math.max(1, Math.round(t.duration / slot)));
    const durK = [defK];
    const shK = Math.round(SHORT_MIN / slot);
    if (t.allowShort && shK < defK && shK > 0) durK.push(shK);
    const reqK = Math.floor((t.hours * 60) / slot + 1e-9);
    const reach = new Uint8Array(reqK + 1);
    reach[0] = 1;
    for (let r = 1; r <= reqK; r++) for (const k of durK) if (r >= k && reach[r - k]) { reach[r] = 1; break; }
    // run[s] = consecutive slots from s not blocked by this type's constraints
    const run = new Int16Array(N + 1);
    const ranges = t.blocked.map(blockedRange);
    for (let s = N - 1; s >= 0; s--) {
      const a = ws + s * slot, b = a + slot;
      run[s] = ranges.some(([x, y]) => x < b && y > a) ? 0 : run[s + 1] + 1;
    }
    return { cfgIdx: i, id: t.id, name: t.name, g: prios.indexOf(t.priority), defK, durK, reqK, reach, run, blocked: ranges.length > 0 };
  });
  const typeById = new Map(types.map((t, i) => [t.id, i]));
  const G = prios.length;

  // fixed sessions (user fixed first, then series blocks when the series period is on)
  const allFixed = cfg.fixed.concat(cfg.series.enabled ? seriesSessions(cfg) : []);
  const fixed = allFixed.map((f, i) => {
    const start = (Number(f.day) || 0) * 1440 + parseHM(f.start);
    const end = start + (Number(f.duration) || 0);
    let s0 = toSlot(start), s1 = toSlotCeil(end);
    const s0c = Math.max(0, s0), s1c = Math.min(N, s1);
    return {
      i, id: f.id ?? `f${i + 1}`, label: f.label || (f.typeId && cfg.types.find((t) => t.id === f.typeId)?.name) || 'אימון קבוע',
      typeId: f.typeId ?? null, ti: f.typeId != null && typeById.has(f.typeId) ? typeById.get(f.typeId) : -1,
      start, end, s0: s0c, s1: Math.max(s0c, s1c), tr: f.trainerId != null ? trIdx(f.trainerId) : -1, series: !!f.series,
    };
  });
  const freeFixed = fixed.filter((f) => f.tr < 0).map((f) => f.i);

  // thursday window
  const TW = R.thursdayWindow || {};
  let win = null;
  if (TW.enabled) {
    const st = (Number(TW.day) || 0) * 1440 + parseHM(TW.start);
    const en = st + (Number(TW.duration) || 0);
    win = { start: st, end: en, s0: Math.max(0, toSlot(st)), s1: Math.min(N, toSlotCeil(en)), tradeoff: Number(TW.tradeoffMinutes) || 0 };
    win.brokenByFixed = fixed.some((f) => f.start < en && f.end > st);
  }

  // availability: outside a trainer's day/hour ranges she cannot teach
  const avail = cfg.trainers.map((t) => Array.from({ length: Math.max(D, 7) }, (_, d) => availOn(t, d)));
  const availDays = avail.map((a) => a.slice(0, D).filter(Boolean).length);
  const availMin = cfg.trainers.map(() => 0);
  const baseHard = cfg.trainers.map((t, tr) => {
    const h = new Uint8Array(N);
    for (let s = 0; s < N; s++) {
      const m = ws + s * slot, tod = m % 1440, r = dayRange(t, dayOfSlot[s]);
      if (!r || tod < r[0] || tod + slot > r[1]) h[s] = 4; else availMin[tr] += slot;
    }
    return h;
  });
  const fullMin = N * slot;

  // nights & sleep options
  const sws = parseHM(R.sleepWindowStart), swe = parseHM(R.sleepWindowEnd);
  const sleepK = Math.ceil(R.sleepMinutes / slot);
  const nights = [];
  for (let d = 0; d < D; d++) {
    const a = d * 1440 + sws, b = (d + 1) * 1440 + swe;
    if (a >= ws && b <= we && b - a >= R.sleepMinutes) nights.push({ d, a, b });
  }
  const NN = nights.length;
  const sleepOpts = []; // [tr][night] -> array of start slots
  for (let tr = 0; tr < T; tr++) {
    const per = [];
    for (const n of nights) {
      // sleep matters only before a day she works
      if (!avail[tr][n.d + 1]) { per.push([]); continue; }
      const all = [];
      for (let m = n.a; m + R.sleepMinutes <= n.b; m += slot) all.push(m);
      const ok = all.filter((m) => !fixed.some((f) => f.tr === tr && f.start < m + R.sleepMinutes && f.end > m));
      per.push((ok.length ? ok : all).map(toSlot));
    }
    sleepOpts.push(per);
  }

  // after options
  const aE = parseHM(R.afterEnd), aR = parseHM(R.afterReturn);
  const afterOpts = [];
  const mkAfter = (tr, d) => ({ tr, d, start: d * 1440 + aE, end: (d + 1) * 1440 + aR });
  const afterTr = Math.max(0, trIdx(cfg.after.trainerId));
  const afterDays = nights.map((n) => n.d);
  if (cfg.after.mode === 'manual' && cfg.after.day != null) {
    afterOpts.push(mkAfter(afterTr, Number(cfg.after.day)));
  } else {
    for (const d of afterDays) if (avail[afterTr][d]) afterOpts.push(mkAfter(afterTr, d));
    if (!afterOpts.length) for (const d of afterDays) afterOpts.push(mkAfter(afterTr, d));
  }
  if (!afterOpts.length) afterOpts.push(mkAfter(afterTr, 0));
  for (const a of afterOpts) { a.s0 = Math.max(0, toSlot(a.start)); a.s1 = Math.min(N, toSlotCeil(a.end)); }

  // cleaning options
  const CK = Math.max(1, Math.ceil(R.cleaningMinutes / slot));
  let cleanOpts = [];
  if (cfg.cleaning.mode === 'manual' && cfg.cleaning.day != null && cfg.cleaning.start) {
    const st = Number(cfg.cleaning.day) * 1440 + parseHM(cfg.cleaning.start);
    cleanOpts = [Math.max(0, Math.min(N - CK, toSlot(st)))];
  } else {
    for (let s = 0; s + CK <= N; s++) {
      const a = ws + s * slot, b = a + CK * slot;
      if (fixed.some((f) => f.start < b && f.end > a)) continue;
      if (win && win.start < b && win.end > a) continue;
      cleanOpts.push(s);
    }
    if (!cleanOpts.length) cleanOpts = [0];
  }

  return {
    cfg, R, slot, ws, we, N, T, brk, maxK, D, off, dayOfSlot, types, G, fixed, freeFixed, win,
    nights, NN, sleepK, sleepOpts, afterOpts, CK, cleanOpts, avail, availDays, baseHard,
    // balance weight: minutes are compared per available day (scaled to a 5-day week)
    availMin,
    balW: availMin.map((a) => (a > 0 ? fullMin / a : 0)),
    // tolerance: 30 real minutes for the trainer with the fewest days
    balTol: 30 * Math.max(1, ...availMin.filter((a) => a > 0).map((a) => fullMin / a)),
    cap: R.dailyMax, capSoft: Math.max(R.dailyMax, R.dailyMaxSoft),
  };
}

// ---------- state ----------
function newState(ctx, rnd) {
  const { T, NN, N } = ctx;
  const sl = new Int16Array(T * NN);
  for (let tr = 0; tr < T; tr++) for (let n = 0; n < NN; n++) {
    const opts = ctx.sleepOpts[tr][n];
    sl[tr * NN + n] = !opts.length ? 0 : rnd ? Math.floor(rnd() * opts.length) : Math.min(opts.length - 1, 4);
  }
  const fa = new Int8Array(ctx.fixed.length).fill(-1);
  ctx.freeFixed.forEach((fi, j) => {
    const d = Math.floor(ctx.fixed[fi].start / 1440);
    const ok = []; for (let t = 0; t < T; t++) if (ctx.avail[t][d]) ok.push(t);
    const pool = ok.length ? ok : Array.from({ length: T }, (_, t) => t);
    fa[fi] = rnd ? pool[Math.floor(rnd() * pool.length)] : pool[j % pool.length];
  });
  return {
    sl, fa,
    af: rnd ? Math.floor(rnd() * ctx.afterOpts.length) : 0,
    cl: rnd ? Math.floor(rnd() * ctx.cleanOpts.length) : 0,
    skip: new Uint8Array(N), pref: new Uint8Array(N), shortp: new Uint8Array(N),
  };
}
function copyState(s) {
  return { sl: s.sl.slice(), fa: s.fa.slice(), af: s.af, cl: s.cl, skip: s.skip.slice(), pref: s.pref.slice(), shortp: s.shortp.slice() };
}

// ---------- decoder ----------
function makeDecoder(ctx) {
  const { N, T, brk, maxK, D, off, dayOfSlot, types, G, fixed, slot, ws } = ctx;
  const NT = types.length;
  const room = new Uint8Array(N);
  const hard = Array.from({ length: T }, () => new Uint8Array(N));
  const sess = Array.from({ length: T }, () => new Uint8Array(N + 2 * brk + 2)); // offset by brk
  const dayMin = new Int32Array(T * D);
  const rem = new Int32Array(NT);
  const sched = new Int32Array(NT);
  const weekMin = new Int32Array(T);
  const vec = new Float64Array(G + 4);
  const balW = ctx.balW;
  const nBal = balW.filter((w) => w > 0).length;
  const balTol = ctx.balTol;
  const minK = Math.min(...types.map((t) => t.durK[t.durK.length - 1]), maxK);
  let rec = null;
  let shortCount = 0;
  let triedMask = 0;

  function addDay(tr, s, k, sign) {
    for (let i = 0; i < k; i++) dayMin[tr * D + dayOfSlot[s + i]] += sign * slot;
  }
  function capOK(tr, s, k, cap) {
    const d1 = dayOfSlot[s], d2 = dayOfSlot[s + k - 1];
    if (d1 === d2) return dayMin[tr * D + d1] + k * slot <= cap;
    let a = 0;
    for (let i = 0; i < k; i++) if (dayOfSlot[s + i] === d1) a++;
    return dayMin[tr * D + d1] + a * slot <= cap && dayMin[tr * D + d2] + (k - a) * slot <= cap;
  }
  // max length a trainer can work starting at s, limited by L
  function trainerLen(tr, s, L) {
    const h = hard[tr], ss = sess[tr];
    for (let i = s; i < s + brk; i++) if (ss[i]) return 0; // [s-brk, s) in offset coords
    let k = 0;
    while (k < L && !h[s + k] && !ss[s + k + brk] && !ss[s + k + 2 * brk]) k++;
    // ensure trailing break: slots [s+k, s+k+brk) free of sessions
    while (k > 0) {
      let ok = true;
      for (let i = 0; i < brk; i++) if (ss[s + k + brk + i]) { ok = false; break; }
      if (ok) break;
      k--;
    }
    return k;
  }

  function place(tr, ti, s, k, pass) {
    for (let i = 0; i < k; i++) { room[s + i] = 2; sess[tr][s + i + brk] = 1; }
    addDay(tr, s, k, 1);
    weekMin[tr] += k * slot;
    rem[ti] -= k; sched[ti] += k;
    if (k < types[ti].defK) shortCount++;
    if (rec) rec.sessions.push({ tr, ti, s, k, pass });
  }

  function pass(st, allowOff, cap, usePrefs, passId) {
    let remaining = 0;
    for (let i = 0; i < NT; i++) remaining += rem[i] > 0 ? 1 : 0;
    if (!remaining) return;
    for (let s = 0; s < N; s++) {
      if (room[s]) continue;
      if (usePrefs && st.skip[s]) continue;
      let L = 0;
      while (L < maxK && s + L < N && !room[s + L] && (allowOff || !off[s + L])) L++;
      if (L < minK) continue;
      // trainer order
      let first = -1;
      if (usePrefs && st.pref[s] > 0 && st.pref[s] <= T) first = st.pref[s] - 1;
      const d0 = dayOfSlot[s];
      let placed = false;
      for (let pass2 = 0; pass2 < T && !placed; pass2++) {
        let tr;
        if (pass2 === 0 && first >= 0) tr = first;
        else {
          // pick the best remaining trainer not yet tried, by day minutes then week minutes
          tr = -1;
          let bestKey = Infinity;
          for (let t = 0; t < T; t++) {
            if (t === first) continue;
            if (triedMask & (1 << t)) continue;
            const key = dayMin[t * D + d0] * 10000 + weekMin[t] * (balW[t] || 99);
            if (key < bestKey) { bestKey = key; tr = t; }
          }
          if (tr < 0) break;
        }
        triedMask |= 1 << tr;
        const Lt = trainerLen(tr, s, L);
        if (Lt < minK) continue;
        const wantShort = usePrefs && st.shortp[s];
        for (let ti = 0; ti < NT && !placed; ti++) {
          const r = rem[ti];
          if (r <= 0) continue;
          const t = types[ti];
          let pick = 0, pickAny = 0;
          const nd = t.durK.length;
          for (let j = 0; j < nd; j++) {
            const k = t.durK[wantShort ? nd - 1 - j : j];
            if (k > Lt || k > r || k > t.run[s] || !capOK(tr, s, k, cap)) continue;
            if (!pickAny) pickAny = k;
            if (t.reach[r - k]) { pick = k; break; }
          }
          if (!pick) pick = pickAny;
          if (pick) { place(tr, ti, s, pick, passId); placed = true; }
        }
      }
      triedMask = 0;
      if (placed) {
        remaining = 0;
        for (let i = 0; i < NT; i++) if (rem[i] > 0) { remaining = 1; break; }
        if (!remaining) return;
      }
    }
  }
  function decode(st, winKept, record) {
    rec = record ? { sessions: [], fixedTr: [], conflicts: [] } : null;
    room.fill(0);
    for (let t = 0; t < T; t++) { hard[t].set(ctx.baseHard[t]); sess[t].fill(0); }
    dayMin.fill(0); weekMin.fill(0); sched.fill(0);
    let conflicts = 0;
    // fixed in room
    for (const f of fixed) for (let s = f.s0; s < f.s1; s++) { if (room[s]) conflicts++; room[s] = 1; }
    if (winKept && ctx.win) for (let s = ctx.win.s0; s < ctx.win.s1; s++) if (!room[s]) room[s] = 3;
    const cs = ctx.cleanOpts[st.cl];
    for (let s = cs; s < cs + ctx.CK && s < N; s++) { if (room[s] === 1) conflicts++; room[s] = 4; }
    // sleep + after
    for (let tr = 0; tr < T; tr++) for (let n = 0; n < ctx.NN; n++) {
      const opts = ctx.sleepOpts[tr][n];
      if (!opts.length) continue;
      const s0 = opts[st.sl[tr * ctx.NN + n]];
      const h = hard[tr];
      for (let s = Math.max(0, s0); s < s0 + ctx.sleepK && s < N; s++) h[s] = 1;
    }
    const A = ctx.afterOpts[st.af];
    for (let s = A.s0; s < A.s1; s++) hard[A.tr][s] |= 2;
    // fixed trainer bookkeeping
    for (const f of fixed) {
      const tr = f.tr >= 0 ? f.tr : st.fa[f.i];
      if (rec) rec.fixedTr[f.i] = tr;
      if (tr < 0 || tr >= T) continue;
      const h = hard[tr], ss = sess[tr];
      let c = 0;
      for (let s = f.s0; s < f.s1; s++) if (h[s]) c++;
      for (let s = f.s0 - brk; s < f.s1 + brk; s++) if (s >= -brk && ss[s + brk]) c++;
      for (let s = f.s0; s < f.s1; s++) ss[s + brk] = 1;
      if (f.s1 > f.s0) addDay(tr, f.s0, f.s1 - f.s0, 1);
      weekMin[tr] += f.end - f.start;
      if (f.end - f.start > ctx.R.maxContinuous && !f.series) c++;
      if (f.ti >= 0) sched[f.ti] += Math.round((f.end - f.start) / slot);
      conflicts += c;
    }
    for (let i = 0; i < T * D; i++) if (dayMin[i] > ctx.capSoft) conflicts++;
    for (let i = 0; i < NT; i++) rem[i] = Math.max(0, types[i].reqK - sched[i]);

    pass(st, false, ctx.cap, true, 0);
    pass(st, true, ctx.cap, false, 1);
    if (ctx.capSoft > ctx.cap) pass(st, true, ctx.capSoft, false, 2);

    // objective
    vec.fill(0);
    vec[0] = -conflicts;
    let total = 0;
    for (let i = 0; i < NT; i++) {
      const m = Math.min(sched[i], types[i].reqK) * slot;
      vec[1 + types[i].g] += m;
    }
    for (let t = 0; t < T; t++) total += weekMin[t];
    vec[G + 1] = total;
    // balance: spread (max-min) of minutes per available day; up to 30 min is "balanced"
    let mx = -Infinity, mn = Infinity;
    for (let t = 0; t < T; t++) {
      if (!balW[t]) continue;
      const v = weekMin[t] * balW[t];
      if (v > mx) mx = v; if (v < mn) mn = v;
    }
    const spread = nBal > 1 ? mx - mn : 0;
    vec[G + 2] = -Math.max(0, spread - balTol);
    // penalties
    let pen = 0;
    let offMin = 0, shorts = 0;
    for (let tr = 0; tr < T; tr++) {
      const ss = sess[tr];
      for (let s = 0; s < N; s++) if (ss[s + brk] && off[s] && room[s] === 2) offMin += slot;
    }
    shorts = shortCount;
    let over = 0;
    for (let i = 0; i < T * D; i++) if (dayMin[i] > ctx.cap) over += 40 + (dayMin[i] - ctx.cap);
    pen += offMin * 2 + over + shorts * 8 + spread * 0.2;
    // cleaning preferences: in preferred hours and while trainers are awake
    let cpen = 0;
    for (let s = cs; s < cs + ctx.CK && s < N; s++) {
      if (off[s]) cpen += 15;
      for (let t = 0; t < T; t++) if (hard[t][s] & 3) cpen += 5;
    }
    pen += cpen;
    vec[G + 3] = -pen;
    if (rec) {
      rec.total = total; rec.offMin = offMin;
      rec.dayMin = Array.from({ length: T }, (_, t) => Array.from(dayMin.subarray(t * D, t * D + D)));
      rec.sched = Array.from(sched); rec.conflictCount = conflicts;
      rec.weekMin = Array.from(weekMin); rec.spread = spread;
    }
    return vec;
  }
  return {
    decode(st, winKept, record) { shortCount = 0; return decode(st, winKept, record); },
    get rec() { return rec; },
    remainingAny() { for (let i = 0; i < NT; i++) if (rem[i] > 0) return true; return false; },
    G,
  };
}

function cmpVec(a, b) {
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    if (d > 1e-9) return 1;
    if (d < -1e-9) return -1;
  }
  return 0;
}

function mutate(ctx, st, rnd) {
  const { T, NN, N } = ctx;
  const FF = ctx.freeFixed;
  // many free fixed blocks (series period): spend more moves on who teaches them
  if (FF.length >= 4 && T > 1 && rnd() < 0.15) {
    const fi = FF[Math.floor(rnd() * FF.length)];
    if (rnd() < 0.5) st.fa[fi] = (st.fa[fi] + 1 + Math.floor(rnd() * (T - 1))) % T;
    else { const fj = FF[Math.floor(rnd() * FF.length)]; const x = st.fa[fi]; st.fa[fi] = st.fa[fj]; st.fa[fj] = x; }
    return;
  }
  const r = rnd();
  if (r < 0.3 && NN > 0) {
    const tr = Math.floor(rnd() * T), n = Math.floor(rnd() * NN);
    const opts = ctx.sleepOpts[tr][n].length;
    if (!opts) return;
    const i = tr * NN + n;
    if (rnd() < 0.5) st.sl[i] = Math.floor(rnd() * opts);
    else st.sl[i] = Math.max(0, Math.min(opts - 1, st.sl[i] + (rnd() < 0.5 ? -1 : 1) * (1 + Math.floor(rnd() * 2))));
  } else if (r < 0.36 && ctx.afterOpts.length > 1) {
    st.af = Math.floor(rnd() * ctx.afterOpts.length);
  } else if (r < 0.46 && ctx.cleanOpts.length > 1) {
    const L = ctx.cleanOpts.length;
    if (rnd() < 0.5) st.cl = Math.floor(rnd() * L);
    else st.cl = Math.max(0, Math.min(L - 1, st.cl + Math.floor((rnd() - 0.5) * 9)));
  } else if (r < 0.5 && ctx.freeFixed.length) {
    const fi = ctx.freeFixed[Math.floor(rnd() * ctx.freeFixed.length)];
    if (T > 1) st.fa[fi] = (st.fa[fi] + 1 + Math.floor(rnd() * (T - 1))) % T;
  } else {
    const n = 1 + Math.floor(rnd() * 3);
    for (let j = 0; j < n; j++) {
      const s = Math.floor(rnd() * N), q = rnd();
      if (q < 0.35) st.skip[s] ^= 1;
      else if (q < 0.8) st.pref[s] = Math.floor(rnd() * (T + 1));
      else st.shortp[s] ^= 1;
    }
  }
}

// core local search; returns { state, vec }
function search(ctx, dec, { winKept, start, rnd, deadline, maxIter, onTick }) {
  let cur = start ? copyState(start) : null;
  let curVec;
  if (!cur) {
    // pick the best of several initial states
    let bestInit = null, bv = null;
    const tries = [newState(ctx, null)];
    for (let i = 0; i < 24; i++) tries.push(newState(ctx, rnd));
    for (const s of tries) {
      const v = dec.decode(s, winKept).slice();
      if (!bv || cmpVec(v, bv) > 0) { bv = v; bestInit = s; }
    }
    cur = bestInit; curVec = bv;
  } else curVec = dec.decode(cur, winKept).slice();
  let best = copyState(cur), bestVec = curVec.slice();
  let sinceImp = 0, it = 0;
  const cand = copyState(cur);
  const assign = (dst, src) => {
    dst.sl.set(src.sl); dst.fa.set(src.fa); dst.af = src.af; dst.cl = src.cl;
    dst.skip.set(src.skip); dst.pref.set(src.pref); dst.shortp.set(src.shortp);
  };
  for (; it < maxIter; it++) {
    if ((it & 63) === 0) {
      if (now() > deadline) break;
      if (onTick) onTick(bestVec);
    }
    assign(cand, cur);
    mutate(ctx, cand, rnd);
    if (rnd() < 0.3) mutate(ctx, cand, rnd);
    const v = dec.decode(cand, winKept);
    const c = cmpVec(v, curVec);
    if (c >= 0) {
      assign(cur, cand); curVec.set(v);
      if (cmpVec(v, bestVec) > 0) { assign(best, cand); bestVec.set(v); sinceImp = 0; continue; }
    }
    if (++sinceImp > 1500) {
      // kick: restart from best with a perturbation
      assign(cur, best);
      for (let j = 0; j < 6; j++) mutate(ctx, cur, rnd);
      curVec = dec.decode(cur, winKept).slice();
      sinceImp = 0;
    }
  }
  return { state: best, vec: bestVec, iterations: it };
}

const seriesMinutes = (ctx) => ctx.fixed.reduce((a, f) => a + (f.series ? f.end - f.start : 0), 0);

// ---------- capacity ----------
export function estimateCapacity(config, { iterations = 600, seed = 7 } = {}) {
  const cfg = normalizeConfig(config);
  cfg.types = [{ id: '__cap', name: 'cap', priority: 1, hours: 1000, duration: 120, allowShort: true, blocked: [] }];
  cfg.fixed = cfg.fixed.map((f) => ({ ...f, typeId: null }));
  const ctx = buildCtx(cfg);
  const dec = makeDecoder(ctx);
  const res = search(ctx, dec, { winKept: !!ctx.win, rnd: mulberry32(seed), deadline: now() + 300, maxIter: iterations });
  return res.vec[ctx.G + 1] - seriesMinutes(ctx);
}

// ---------- solve ----------
export function solve(config, { timeBudgetMs = 2500, seed, onProgress, iterations } = {}) {
  const t0 = now();
  const cfg = normalizeConfig(config);
  const ctx = buildCtx(cfg);
  const dec = makeDecoder(ctx);
  const rnd = mulberry32(seed == null ? 1 : seed);
  // with an explicit seed the run is bounded by iterations (reproducible); time budget is a safety cap
  const maxIter = iterations != null ? iterations : seed != null ? 100000 : Infinity;
  const deadline = t0 + timeBudgetMs;
  let lastProg = t0;
  const prog = (pct, vec) => {
    if (!onProgress) return;
    const tn = now();
    if (tn - lastProg < 120) return;
    lastProg = tn;
    try { onProgress({ pct: Math.min(99, Math.round(pct)), best: { totalMinutes: vec[ctx.G + 1] } }); } catch { /* ignore */ }
  };

  const capacity = estimateCapacity(cfg, { iterations: 3000, seed: (seed ?? 1) + 17 });
  const totalReq = ctx.types.reduce((a, t) => a + t.reqK * ctx.slot, 0);
  const winPossible = !!ctx.win && !ctx.win.brokenByFixed;
  const remainingBudget = deadline - now();
  const split = winPossible ? 0.62 : 1;
  const it1 = maxIter === Infinity ? Infinity : Math.ceil(maxIter * split);

  const r1 = search(ctx, dec, {
    winKept: winPossible, rnd, deadline: now() + remainingBudget * split, maxIter: it1,
    onTick: (v) => prog(((now() - t0) / timeBudgetMs) * 100, v),
  });
  let chosen = r1, kept = winPossible, gain = 0;
  dec.decode(r1.state, winPossible);
  const unmet = dec.remainingAny();
  if (winPossible && unmet) {
    const r2 = search(ctx, dec, {
      winKept: false, start: r1.state, rnd, deadline, maxIter: maxIter === Infinity ? Infinity : maxIter - it1,
      onTick: (v) => prog(((now() - t0) / timeBudgetMs) * 100, v),
    });
    gain = r2.vec[ctx.G + 1] - r1.vec[ctx.G + 1];
    if (gain > ctx.win.tradeoff && cmpVec(r2.vec, r1.vec) > 0) { chosen = r2; kept = false; }
  }
  // balance polish: only when the best schedule is still unbalanced and time remains
  let polishIt = 0;
  if (chosen.vec[ctx.G + 2] < 0 && now() < deadline - 50) {
    const r3 = search(ctx, dec, {
      winKept: kept, start: chosen.state, rnd, deadline, maxIter: maxIter === Infinity ? Infinity : 40000,
      onTick: (v) => prog(((now() - t0) / timeBudgetMs) * 100, v),
    });
    polishIt = r3.iterations;
    if (cmpVec(r3.vec, chosen.vec) > 0) chosen = { ...r3, iterations: chosen.iterations };
  }
  dec.decode(chosen.state, kept, true);
  const result = buildResult(ctx, chosen.state, dec.rec, kept, gain, Math.max(capacity, dec.rec.total - seriesMinutes(ctx)), totalReq);
  result.stats = { iterations: r1.iterations + (chosen === r1 ? 0 : chosen.iterations) + polishIt, ms: Math.round(now() - t0) };
  if (onProgress) try { onProgress({ pct: 100, best: { totalMinutes: result.summary.totalMinutes } }); } catch { /* ignore */ }
  return result;
}

function buildResult(ctx, st, rec, kept, gain, capacity, totalReq) {
  const { cfg, slot, ws, T, types } = ctx;
  const R = cfg.rules;
  const trId = (i) => cfg.trainers[i]?.id ?? null;
  const isOff = (a, b) => {
    const pS = parseHM(R.preferredStart), pE = parseHM(R.preferredEnd);
    for (let m = a; m < b; m += slot) { const tod = m % 1440; if (tod < pS || tod + slot > pE) return true; }
    return false;
  };
  const sessions = [];
  for (const f of ctx.fixed) {
    const tr = rec.fixedTr[f.i];
    const tdef = f.typeId ? cfg.types.find((t) => t.id === f.typeId) : null;
    const sess = {
      id: f.id, typeId: f.series ? SERIES_TYPE : f.typeId, label: f.label, trainerId: trId(tr), start: f.start, end: f.end,
      fixed: true, short: !!(tdef && f.end - f.start < tdef.duration), offHours: isOff(f.start, f.end),
    };
    if (f.series) sess.series = true;
    sessions.push(sess);
  }
  let n = 0;
  for (const s of rec.sessions) {
    const t = types[s.ti];
    const a = ws + s.s * slot, b = a + s.k * slot;
    sessions.push({
      id: `s${++n}`, typeId: t.id, label: t.name, trainerId: trId(s.tr), start: a, end: b,
      fixed: false, short: s.k < t.defK, offHours: isOff(a, b),
    });
  }
  sessions.sort((x, y) => x.start - y.start);
  const cs = ws + ctx.cleanOpts[st.cl] * slot;
  const cleaning = { start: cs, end: cs + R.cleaningMinutes };
  const sleep = [];
  for (let tr = 0; tr < T; tr++) for (let i = 0; i < ctx.NN; i++) {
    const opts = ctx.sleepOpts[tr][i];
    if (!opts.length) continue;
    const s0 = ws + opts[st.sl[tr * ctx.NN + i]] * slot;
    sleep.push({ trainerId: trId(tr), start: s0, end: s0 + R.sleepMinutes });
  }
  const A = ctx.afterOpts[st.af];
  const after = { trainerId: trId(A.tr), day: A.d, start: A.start, end: A.end };

  const perType = {};
  for (const t of cfg.types) perType[t.id] = { requested: Math.round(t.hours * 60), scheduled: 0 };
  for (const s of sessions) if (s.typeId && perType[s.typeId]) perType[s.typeId].scheduled += s.end - s.start;
  const perTrainerDay = {};
  cfg.trainers.forEach((t, i) => { perTrainerDay[t.id] = rec.dayMin[i].slice(0, 5).concat(Array(Math.max(0, 5 - rec.dayMin[i].length)).fill(0)); });
  const totalMinutes = sessions.reduce((a, s) => a + (s.end - s.start), 0);
  const denom = R.weekEnd - R.weekStart - R.cleaningMinutes;
  const perTrainer = {};
  cfg.trainers.forEach((t, i) => {
    perTrainer[t.id] = { minutes: perTrainerDay[t.id].reduce((a, b) => a + b, 0), availableDays: ctx.availDays[i], availableMinutes: ctx.availMin[i] };
  });
  const sumAvail = ctx.availMin.reduce((a, b) => a + b, 0) || 1;
  cfg.trainers.forEach((t, i) => { perTrainer[t.id].target = Math.round((totalMinutes * ctx.availMin[i]) / sumAvail); });
  const proportional = new Set(ctx.availMin.filter((a) => a > 0)).size > 1;
  const act = cfg.trainers.filter((t, i) => ctx.availMin[i] > 0).map((t) => perTrainer[t.id]);
  // equal availability: plain max-min difference; otherwise the largest deviation from the fair share
  const diffMinutes = act.length < 2 ? 0 : proportional
    ? Math.round(Math.max(...act.map((p) => Math.abs(p.minutes - p.target))))
    : Math.max(...act.map((p) => p.minutes)) - Math.min(...act.map((p) => p.minutes));
  const balance = { diffMinutes, spreadMinutes: Math.round(rec.spread), balanced: rec.spread <= ctx.balTol + 1e-9, proportional };
  const seriesMin = sessions.reduce((a, s) => a + (s.series ? s.end - s.start : 0), 0);
  const summary = { perType, seriesMinutes: seriesMin, perTrainerDay, perTrainer, balance, totalMinutes, capacityMinutes: capacity, utilization: denom > 0 ? totalMinutes / denom : 0 };

  const result = { sessions, cleaning, sleep, after, thursdayWindowKept: !!(ctx.win && kept), summary, warnings: [], violations: [] };
  const W = result.warnings;
  if (totalReq > capacity) W.push(`הדרישה (${hoursStr(totalReq)} ש') גבוהה מהקיבולת המשוערת (כ-${hoursStr(capacity)} ש')`);
  const sortedTypes = [...cfg.types].sort((a, b) => a.priority - b.priority);
  for (const t of sortedTypes) {
    const p = perType[t.id];
    if (p.requested > p.scheduled) {
      if (t.blocked.length && totalReq <= capacity) W.push(`${t.name}: נכנסו ${hoursStr(p.scheduled)} מתוך ${hoursStr(p.requested)} ש' בגלל אילוצים`);
      else W.push(`לא נכנסו ${hoursStr(p.requested - p.scheduled)} שעות ${t.name}${t.blocked.length ? ' (יש גם אילוצים לסוג הזה)' : ''}`);
    }
    if (p.requested % 30) W.push(`הדרישה ל${t.name} עוגלה לחצאי שעות`);
  }
  if (ctx.win) {
    if (ctx.win.brokenByFixed) W.push('אימון קבוע נופל בחלון הפנוי של יום חמישי');
    else if (!kept) W.push(`שבירת חלון חמישי הוסיפה ${gain} דק'`);
  }
  if (!balance.balanced) W.push(`חלוקת השעות בין המאמנות לא מאוזנת לגמרי (${balance.proportional ? 'סטייה מהחלק היחסי' : 'הפרש'} של ${diffMinutes} דק')`);
  const offMin = sessions.filter((s) => !s.fixed && s.offHours).reduce((a, s) => a + s.end - s.start, 0);
  if (offMin) W.push(`שובצו ${offMin} דק' מחוץ לשעות המועדפות (${R.preferredStart}-${R.preferredEnd}) כדי להגדיל ניצול`);
  cfg.trainers.forEach((t) => {
    perTrainerDay[t.id].forEach((m, d) => {
      if (m > R.dailyMax && m <= R.dailyMaxSoft) W.push(`${t.name} מאמנת ${m} דק' ביום ${DAY_NAMES[d]} (מעל ${R.dailyMax}, כדי להגדיל ניצול)`);
    });
  });
  result.violations = validate(cfg, result);
  const fixedIds = new Set(ctx.fixed.map((f) => f.id));
  const seriesIds = new Set(ctx.fixed.filter((f) => f.series).map((f) => f.id));
  const seen = new Set();
  for (const v of result.violations) {
    const ids = v.sessionIds || [];
    if (ids.some((id) => fixedIds.has(id)) || v.code === 'fixed' || v.code === 'series_missing') {
      const msg = `${ids.some((id) => seriesIds.has(id)) || v.code === 'series_missing' ? 'בלוק סדרות' : 'אימון קבוע'} מתנגש בחוקים: ${v.message}`;
      if (!seen.has(msg)) { seen.add(msg); W.push(msg); }
    }
  }
  return result;
}

// ---------- validate ----------
export function validate(config, result) {
  const cfg = normalizeConfig(config);
  const R = cfg.rules;
  const V = [];
  const push = (code, message, extra = {}) => V.push({ code, message, ...extra });
  if (!result || !Array.isArray(result.sessions)) { push('no_result', 'אין תוצאה לבדיקה'); return V; }
  const tName = new Map(cfg.trainers.map((t) => [t.id, t.name]));
  const typeMap = new Map(cfg.types.map((t) => [t.id, t]));
  const S = [...result.sessions].sort((a, b) => a.start - b.start);
  const desc = (s) => `"${s.label || typeMap.get(s.typeId)?.name || 'אימון'}" (${when(s.start)})`;

  for (const s of S) {
    if (!tName.has(s.trainerId)) push('trainer', `לאימון ${desc(s)} לא שובצה מאמנת תקינה`, { sessionIds: [s.id] });
    if (!(s.end > s.start)) push('duration', `לאימון ${desc(s)} משך לא תקין`, { sessionIds: [s.id] });
    if (s.end - s.start > R.maxContinuous && !(s.series && s.typeId === SERIES_TYPE && cfg.series.enabled)) push('max_continuous', `האימון ${desc(s)} ארוך מ-${R.maxContinuous} דק'`, { sessionIds: [s.id] });
    if (s.start < R.weekStart || s.end > R.weekEnd) push('outside_week', `האימון ${desc(s)} מחוץ לשבוע העבודה`, { sessionIds: [s.id] });
    if (!s.fixed) {
      const t = typeMap.get(s.typeId);
      if (!t) push('type', `לאימון ${desc(s)} סוג לא מוכר`, { sessionIds: [s.id] });
      else {
        const d = s.end - s.start;
        const ok = d === Math.min(t.duration, R.maxContinuous) || (t.allowShort && d === SHORT_MIN && SHORT_MIN < t.duration);
        if (!ok) push('duration', `משך האימון ${desc(s)} (${d} דק') לא מותר לסוג ${t.name}`, { sessionIds: [s.id] });
      }
    }
  }
  // per-type constraints (אילוצים): no session of the type inside a blocked range
  for (const t of cfg.types) {
    if (!t.blocked.length) continue;
    const ranges = t.blocked.map(blockedRange);
    for (const s of S) {
      if (s.typeId !== t.id) continue;
      const hit = ranges.find(([a, e]) => s.start < e && s.end > a);
      if (hit) push('blocked', `האימון ${desc(s)} נופל באילוץ של ${t.name} (${when(hit[0])}–${fmt(hit[1])})`, { sessionIds: [s.id] });
    }
  }
  // series blocks: each one present, exactly in place, one session
  if (cfg.series.enabled) {
    for (const b of seriesSessions(cfg)) {
      const a = b.day * 1440 + parseHM(b.start), e = a + b.duration;
      if (!S.some((s) => s.series && s.start === a && s.end === e)) push('series_missing', `חסר בלוק סדרות ${when(a)}`);
    }
  } else if (S.some((s) => s.series)) push('series_off', 'שובצו סדרות למרות שתקופת סדרות כבויה');
  // no overlaps at all
  for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length && S[j].start < S[i].end; j++) {
    push('overlap', `האימונים ${desc(S[i])} ו-${desc(S[j])} חופפים`, { sessionIds: [S[i].id, S[j].id] });
  }
  // cleaning
  const C = result.cleaning;
  if (!C || !(C.end - C.start >= R.cleaningMinutes)) push('cleaning', `חסרה שעת יש"פ+ניקיון של ${R.cleaningMinutes} דק'`);
  else {
    if (C.start < R.weekStart || C.end > R.weekEnd) push('cleaning', 'שעת יש"פ+ניקיון מחוץ לשבוע העבודה');
    for (const s of S) if (s.start < C.end && s.end > C.start) push('cleaning_overlap', `האימון ${desc(s)} חופף לשעת יש"פ+ניקיון`, { sessionIds: [s.id] });
    if (cfg.cleaning.mode === 'manual' && cfg.cleaning.day != null && cfg.cleaning.start) {
      const want = Number(cfg.cleaning.day) * 1440 + parseHM(cfg.cleaning.start);
      if (C.start !== want) push('cleaning_manual', 'שעת יש"פ+ניקיון לא במיקום שנקבע ידנית');
    }
  }
  // per trainer
  const sleeps = Array.isArray(result.sleep) ? result.sleep : [];
  const sws = parseHM(R.sleepWindowStart), swe = parseHM(R.sleepWindowEnd);
  const nights = [];
  for (let d = 0; d < 7; d++) {
    const a = d * 1440 + sws, b = (d + 1) * 1440 + swe;
    if (a >= R.weekStart && b <= R.weekEnd) nights.push({ d, a, b });
  }
  for (const tr of cfg.trainers) {
    const mine = S.filter((s) => s.trainerId === tr.id);
    for (const s of mine) for (let d = Math.floor(s.start / 1440); d * 1440 < s.end; d++) {
      const r = dayRange(tr, d);
      if (!r) { push('unavailable', `${tr.name} לא זמינה ביום ${DAY_NAMES[d]} אך משובצת: ${desc(s)}`, { sessionIds: [s.id], trainerId: tr.id }); break; }
      const a = Math.max(s.start, d * 1440) - d * 1440, b = Math.min(s.end, (d + 1) * 1440) - d * 1440;
      if (a < r[0] || b > r[1]) { push('unavailable', `${tr.name} זמינה ביום ${DAY_NAMES[d]} רק ${fmt(r[0])}-${r[1] >= 1440 ? '24:00' : fmt(r[1])}, אך משובצת: ${desc(s)}`, { sessionIds: [s.id], trainerId: tr.id }); break; }
    }
    for (let i = 1; i < mine.length; i++) {
      const gap = mine[i].start - mine[i - 1].end;
      if (gap >= 0 && gap < R.minBreak) push('break', `ל${tr.name} אין ${R.minBreak} דק' הפסקה בין ${desc(mine[i - 1])} ל-${desc(mine[i])}`, { sessionIds: [mine[i - 1].id, mine[i].id] });
    }
    // sleep
    const ts = sleeps.filter((z) => z.trainerId === tr.id);
    for (const n of nights) {
      if (!availOn(tr, n.d + 1)) continue;
      const inN = ts.filter((z) => z.start >= n.a && z.start < n.b);
      const good = inN.find((z) => z.end - z.start >= R.sleepMinutes && z.end <= n.b);
      if (!good) { push('sleep', `ל${tr.name} אין בלוק שינה של ${R.sleepMinutes / 60} שעות בלילה שבין ${DAY_NAMES[n.d]} ל${DAY_NAMES[n.d + 1]} (${R.sleepWindowStart}-${R.sleepWindowEnd})`); continue; }
      for (const s of mine) if (s.start < good.end && s.end > good.start) push('sleep_overlap', `${tr.name} מאמנת בזמן השינה: ${desc(s)}`, { sessionIds: [s.id] });
    }
    // daily max (split at midnight)
    const days = {};
    for (const s of mine) {
      for (let m = s.start; m < s.end;) {
        const d = Math.floor(m / 1440), e = Math.min(s.end, (d + 1) * 1440);
        days[d] = (days[d] || 0) + (e - m);
        m = e;
      }
    }
    for (const [d, m] of Object.entries(days)) {
      if (m > R.dailyMaxSoft) push('daily_max', `${tr.name} מאמנת ${m} דק' ביום ${DAY_NAMES[d]} (מעל ${R.dailyMaxSoft})`, { trainerId: tr.id, day: Number(d) });
    }
  }
  // after
  const A = result.after;
  if (!A || !tName.has(A.trainerId)) push('after', 'חסר יום אפטר');
  else {
    const aS = A.day * 1440 + parseHM(R.afterEnd), aE = (A.day + 1) * 1440 + parseHM(R.afterReturn);
    if (!nights.some((n) => n.d === A.day)) push('after', `יום האפטר (${DAY_NAMES[A.day] ?? A.day}) לא תקין`);
    if (A.start > aS || A.end < aE) push('after', 'חלון האפטר קצר מהנדרש');
    if (A.trainerId !== cfg.after.trainerId) push('after_trainer', `האפטר צריך להיות של ${tName.get(cfg.after.trainerId) ?? 'המאמנת שנקבעה'}`);
    if (cfg.after.mode === 'manual' && cfg.after.day != null && Number(A.day) !== Number(cfg.after.day)) push('after_manual', 'יום האפטר לא תואם להגדרה הידנית');
    for (const s of S) if (s.trainerId === A.trainerId && s.start < aE && s.end > aS) {
      push('after_overlap', `${tName.get(A.trainerId)} באפטר אך מאמנת: ${desc(s)}`, { sessionIds: [s.id] });
    }
  }
  // demand never exceeded by engine-placed sessions
  for (const t of cfg.types) {
    const req = Math.round(t.hours * 60);
    const fx = S.filter((s) => s.fixed && s.typeId === t.id).reduce((a, s) => a + s.end - s.start, 0);
    const auto = S.filter((s) => !s.fixed && s.typeId === t.id).reduce((a, s) => a + s.end - s.start, 0);
    if (auto > Math.max(0, req - fx)) push('over_demand', `שובצו ל${t.name} יותר שעות מהנדרש`);
  }
  // thursday window, when reported kept
  const TW = R.thursdayWindow;
  if (TW && TW.enabled && result.thursdayWindowKept) {
    const a = TW.day * 1440 + parseHM(TW.start), b = a + TW.duration;
    for (const s of S) if (s.start < b && s.end > a) push('thursday_window', `האימון ${desc(s)} נופל בחלון חמישי שסומן כפנוי`, { sessionIds: [s.id] });
  }
  return V;
}
