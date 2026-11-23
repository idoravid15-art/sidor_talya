import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve, validate, DEFAULT_CONFIG, fmt, dayOf, parseHM, normalizeConfig } from '../js/engine.js';

const OPTS = { seed: 42, timeBudgetMs: 400 };
function cfgWith(hours, patch = {}) {
  const c = structuredClone(DEFAULT_CONFIG);
  c.types.forEach((t) => { t.hours = hours[t.id] ?? 0; });
  return { ...c, ...patch, rules: { ...c.rules, ...(patch.rules || {}) } };
}
const LIGHT = { maamanot: 6, kamas: 4, cadets2: 3 };
const TYPICAL = { maamanot: 20, kamas: 16, cadets2: 14, officersQual: 9, cadetsQual: 9 };
const OVER = { maamanot: 30, kamas: 30, cadets2: 30, officersQual: 15, cadetsQual: 15 };

function checkHard(cfg, r) {
  assert.deepEqual(validate(cfg, r), []);
  assert.deepEqual(r.violations, []);
  const R = cfg.rules;
  // no overlaps (room), nothing during cleaning
  const S = [...r.sessions].sort((a, b) => a.start - b.start);
  for (let i = 1; i < S.length; i++) assert.ok(S[i].start >= S[i - 1].end, 'overlap');
  for (const s of S) assert.ok(s.end <= r.cleaning.start || s.start >= r.cleaning.end, 'cleaning overlap');
  // daily caps
  for (const days of Object.values(r.summary.perTrainerDay)) for (const m of days) assert.ok(m <= R.dailyMaxSoft);
  // sleep blocks inside window, 4 nights per trainer
  const ncfg = normalizeConfig(cfg);
  for (const tr of ncfg.trainers) {
    const sl = r.sleep.filter((z) => z.trainerId === tr.id);
    const days = tr.days;
    assert.equal(sl.length, [1, 2, 3, 4].filter((d) => days.includes(d)).length);
    sl.forEach((z) => {
      const n = Math.floor((z.start - 720) / 1440); // night index (start in [20:00, 04:00])
      assert.ok(z.start >= n * 1440 + parseHM(R.sleepWindowStart), 'sleep start');
      assert.ok(z.end <= (n + 1) * 1440 + parseHM(R.sleepWindowEnd), 'sleep end');
      assert.equal(z.end - z.start, R.sleepMinutes);
    });
  }
  // availability: only inside the trainer's day/hour ranges
  for (const tr of ncfg.trainers) for (const s of r.sessions.filter((x) => x.trainerId === tr.id)) {
    for (let d = Math.floor(s.start / 1440); d * 1440 < s.end; d++) {
      assert.ok(d in tr.availability, `${tr.id} on day ${d}`);
      const rg = tr.availability[d];
      if (!rg) continue;
      const a = Math.max(s.start, d * 1440) - d * 1440, b = Math.min(s.end, (d + 1) * 1440) - d * 1440;
      assert.ok(a >= parseHM(rg.from) && b <= (parseHM(rg.to) || 1440), `${tr.id} outside hours on day ${d}`);
    }
  }
  // after always on the configured (default: manager) trainer
  assert.equal(r.after.trainerId, cfg.after?.trainerId ?? 't1');
  // never exceed requested
  for (const [id, p] of Object.entries(r.summary.perType)) assert.ok(p.scheduled <= p.requested, id);
}

test('helpers', () => {
  assert.equal(fmt(600), '10:00');
  assert.equal(fmt(1440 + 90), '01:30');
  assert.equal(dayOf(6599), 4);
});

test('empty demand', () => {
  const c = cfgWith({});
  const r = solve(c, OPTS);
  checkHard(c, r);
  assert.equal(r.summary.totalMinutes, 0);
  assert.equal(r.thursdayWindowKept, true);
});

test('light demand: fully met, window kept, in preferred hours', () => {
  const c = cfgWith(LIGHT);
  const r = solve(c, OPTS);
  checkHard(c, r);
  for (const p of Object.values(r.summary.perType)) assert.equal(p.scheduled, p.requested);
  assert.equal(r.thursdayWindowKept, true);
  assert.ok(r.sessions.every((s) => !s.offHours));
});

test('typical week 68h', () => {
  const c = cfgWith(TYPICAL);
  const r = solve(c, { seed: 3, timeBudgetMs: 1500 });
  checkHard(c, r);
  assert.ok(r.summary.capacityMinutes > 3000);
  assert.ok(r.summary.totalMinutes >= 3600);
  assert.ok(r.summary.balance.spreadMinutes <= 30, `spread ${r.summary.balance.spreadMinutes}`);
});

const weekMins = (r) => Object.fromEntries(Object.entries(r.summary.perTrainer).map(([k, v]) => [k, v.minutes]));

test('defaults: Talya is t1 and the manager; after defaults to her', () => {
  assert.equal(DEFAULT_CONFIG.trainers[0].name, 'טליה');
  assert.equal(DEFAULT_CONFIG.trainers[0].isManager, true);
  assert.equal(DEFAULT_CONFIG.trainers[1].name, 'מאמנת ב');
  assert.equal(DEFAULT_CONFIG.after.trainerId, 't1');
  // legacy config without after.trainerId still resolves to the manager
  const c = cfgWith(LIGHT, { after: { mode: 'auto', trainerId: null, day: null } });
  const r = solve(c, OPTS);
  assert.equal(r.after.trainerId, 't1');
  assert.deepEqual(validate(c, r), []);
});

test('after: auto picks the day but trainer stays Talya; manual day respected', () => {
  for (const seed of [1, 2, 3]) {
    const r = solve(cfgWith(TYPICAL), { seed, timeBudgetMs: 400 });
    assert.equal(r.after.trainerId, 't1');
  }
  const c = cfgWith(TYPICAL, { after: { mode: 'manual', trainerId: 't1', day: 2 } });
  const r = solve(c, OPTS);
  checkHard(c, r);
  assert.equal(r.after.day, 2);
  const bad = structuredClone(r); bad.after.trainerId = 't2';
  assert.ok(validate(c, bad).some((v) => v.code === 'after_trainer'));
});

test('balance: 2 trainers within 30 min (typical and light)', () => {
  for (const [h, seed] of [[TYPICAL, 3], [{ maamanot: 10, kamas: 6, cadets2: 4, officersQual: 3, cadetsQual: 3 }, 4]]) {
    const c = cfgWith(h);
    const r = solve(c, { seed, timeBudgetMs: 1500 });
    checkHard(c, r);
    const m = Object.values(weekMins(r));
    assert.ok(Math.abs(m[0] - m[1]) <= 30, `minutes ${m}`);
  }
});

const RESERVIST = { id: 't3', name: 'מילואימניקית', days: [1, 2, 3] };
test('3 trainers, reservist Mon-Wed: availability, sleep, proportional balance', () => {
  const c = cfgWith(TYPICAL);
  c.trainers.push(RESERVIST);
  const r = solve(c, { seed: 3, timeBudgetMs: 2500 });
  checkHard(c, r);
  assert.ok(r.summary.totalMinutes >= 3600);
  assert.ok(r.sessions.some((s) => s.trainerId === 't3'));
  // reservist sleeps only before days she works (Mon, Tue, Wed)
  assert.equal(r.sleep.filter((z) => z.trainerId === 't3').length, 3);
  const pt = r.summary.perTrainer;
  assert.equal(pt.t3.availableDays, 3);
  assert.ok(Math.abs(pt.t1.minutes - pt.t2.minutes) <= 60, JSON.stringify(weekMins(r)));
  assert.ok(Math.abs(pt.t3.minutes * pt.t1.availableMinutes / pt.t3.availableMinutes - pt.t1.minutes) <= 120, JSON.stringify(weekMins(r)));
});

test('N trainers 1..5 produce valid schedules; fixed session trainer t3', () => {
  for (const n of [1, 3, 5]) {
    const c = cfgWith(LIGHT, {
      fixed: n >= 3 ? [{ id: 'fx3', typeId: 'kamas', label: '', day: 1, start: '12:00', duration: 120, trainerId: 't3' }] : [],
    });
    c.trainers = Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, name: `מ${i + 1}`, isManager: i === 0 }));
    const r = solve(c, { seed: 2, timeBudgetMs: 600 });
    checkHard(c, r);
    for (const p of Object.values(r.summary.perType)) assert.equal(p.scheduled, p.requested);
    if (n >= 3) assert.equal(r.sessions.find((s) => s.id === 'fx3').trainerId, 't3');
  }
});

test('trainer unavailable day: validate flags sessions on it', () => {
  const c = cfgWith(LIGHT);
  c.trainers[1].availability = { 0: null, 1: null, 2: null };
  const r = solve(c, OPTS);
  checkHard(c, r);
  assert.ok(r.sessions.filter((s) => s.trainerId === 't2').every((s) => s.end <= 3 * 1440));
  const bad = structuredClone(r);
  bad.sessions.push({ id: 'x', typeId: null, label: 'x', trainerId: 't2', start: 4 * 1440 + 600, end: 4 * 1440 + 690, fixed: true });
  assert.ok(validate(c, bad).some((v) => v.code === 'unavailable'));
});

test('overload: priorities respected', () => {
  const c = cfgWith(OVER);
  const r = solve(c, { seed: 5, timeBudgetMs: 1500 });
  checkHard(c, r);
  const order = [...c.types].sort((a, b) => a.priority - b.priority).filter((t) => t.hours > 0);
  const frac = order.map((t) => r.summary.perType[t.id].scheduled / r.summary.perType[t.id].requested);
  for (let i = 1; i < frac.length; i++) assert.ok(frac[i - 1] >= frac[i] - 1e-9, `priority ${i}: ${frac}`);
  assert.equal(frac[0], 1);
  assert.ok(r.warnings.length > 0);
});

test('fixed sessions (with and without trainer)', () => {
  const c = cfgWith(TYPICAL, {
    fixed: [
      { id: 'fx1', typeId: 'kamas', label: 'קמ"ס מיוחד', day: 1, start: '09:00', duration: 120, trainerId: 't1' },
      { id: 'fx2', typeId: null, label: 'ביקור', day: 2, start: '14:00', duration: 90, trainerId: null },
    ],
  });
  const r = solve(c, OPTS);
  checkHard(c, r);
  const f1 = r.sessions.find((s) => s.id === 'fx1');
  const f2 = r.sessions.find((s) => s.id === 'fx2');
  assert.equal(f1.start, 1440 + 540); assert.equal(f1.trainerId, 't1'); assert.ok(f1.fixed);
  assert.equal(f2.start, 2 * 1440 + 840); assert.ok(['t1', 't2'].includes(f2.trainerId));
});

test('conflicting fixed session is placed and warned, no crash', () => {
  const c = cfgWith(LIGHT, {
    fixed: [{ id: 'bad', typeId: null, label: 'ארוך', day: 1, start: '10:00', duration: 180, trainerId: 't1' }],
  });
  const r = solve(c, OPTS);
  assert.ok(r.sessions.some((s) => s.id === 'bad'));
  assert.ok(r.violations.length > 0);
  assert.ok(r.warnings.some((w) => w.includes('אימון קבוע')));
});

test('manual after and manual cleaning', () => {
  const c = cfgWith(TYPICAL, {
    after: { mode: 'manual', trainerId: 't2', day: 1 },
    cleaning: { mode: 'manual', day: 2, start: '13:00' },
  });
  const r = solve(c, OPTS);
  checkHard(c, r);
  assert.equal(r.after.trainerId, 't2'); assert.equal(r.after.day, 1);
  assert.equal(r.cleaning.start, 2 * 1440 + 780);
  assert.ok(r.sessions.filter((s) => s.trainerId === 't2').every((s) => s.end <= r.after.start || s.start >= r.after.end));
});

test('thursday window broken only with real gain', () => {
  const c = cfgWith(OVER);
  const r = solve(c, { seed: 9, timeBudgetMs: 1200 });
  checkHard(c, r);
  if (!r.thursdayWindowKept) assert.ok(r.warnings.some((w) => w.includes('חלון חמישי')));
  else {
    const a = 4 * 1440 + 720;
    assert.ok(r.sessions.every((s) => s.end <= a || s.start >= a + 30));
  }
});

test('validate detects violations', () => {
  const c = cfgWith(LIGHT);
  const r = solve(c, OPTS);
  const bad = structuredClone(r);
  const s = bad.sessions[0];
  bad.sessions.push({ ...s, id: 'dup' });
  const codes = validate(c, bad).map((v) => v.code);
  assert.ok(codes.includes('overlap'));
  const bad2 = structuredClone(r);
  bad2.sleep = bad2.sleep.slice(1);
  assert.ok(validate(c, bad2).some((v) => v.code === 'sleep'));
});

test('deterministic with same seed and iteration budget', () => {
  const c = cfgWith(TYPICAL);
  const a = solve(c, { seed: 11, iterations: 4000, timeBudgetMs: 60000 });
  const b = solve(c, { seed: 11, iterations: 4000, timeBudgetMs: 60000 });
  assert.deepEqual(a.sessions, b.sessions);
  assert.deepEqual(a.sleep, b.sleep);
});

// ---------- series period (תקופת סדרות) ----------
const SERIES_AT = [
  [0, '18:00', '22:00'], [1, '06:00', '09:00'], [1, '18:00', '22:00'], [2, '06:00', '09:00'],
  [2, '18:00', '22:00'], [3, '06:00', '09:00'], [3, '18:00', '22:00'], [4, '06:00', '09:00'],
];
test('series off by default; on: blocks placed exactly, one trainer each, valid', () => {
  assert.equal(DEFAULT_CONFIG.series.enabled, false);
  assert.ok(solve(cfgWith(LIGHT), OPTS).sessions.every((s) => !s.series));
  // typical week during a series period: demand that fits next to the 28h of series
  const c = cfgWith({ maamanot: 14, kamas: 10, cadets2: 8, officersQual: 6, cadetsQual: 6 }, { series: { enabled: true } });
  const r = solve(c, { seed: 1, timeBudgetMs: 2500 });
  checkHard(c, r);
  const ser = r.sessions.filter((s) => s.series);
  assert.equal(ser.length, SERIES_AT.length);
  for (const [d, a, b] of SERIES_AT) {
    const s = ser.find((x) => x.start === d * 1440 + parseHM(a));
    assert.ok(s, `block ${d} ${a}`);
    assert.equal(s.end, d * 1440 + parseHM(b));
    assert.equal(s.typeId, 'series');
    assert.ok(['t1', 't2'].includes(s.trainerId));
  }
  // after-trainer never holds an evening block on her after day
  assert.ok(!ser.some((s) => s.trainerId === r.after.trainerId && s.start < r.after.end && s.end > r.after.start));
  // series do not count toward demand, but count in trainer hours
  const typed = Object.values(r.summary.perType).reduce((a, p) => a + p.scheduled, 0);
  assert.equal(r.summary.totalMinutes, typed + r.summary.seriesMinutes);
  assert.equal(r.summary.seriesMinutes, 28 * 60);
  for (const p of Object.values(r.summary.perType)) assert.equal(p.scheduled, p.requested);
  const m = Object.values(r.summary.perTrainer).map((p) => p.minutes);
  assert.ok(Math.abs(m[0] - m[1]) <= 30, `minutes ${m}`);
});

test('validate: long block allowed only for series sessions', () => {
  const c = cfgWith(LIGHT, { series: { enabled: true } });
  const r = solve(c, OPTS);
  assert.deepEqual(validate(c, r), []);
  const bad = structuredClone(r);
  const s = bad.sessions.find((x) => x.series);
  delete s.series; s.typeId = null;
  assert.ok(validate(c, bad).some((v) => v.code === 'max_continuous'));
  const miss = structuredClone(r);
  miss.sessions = miss.sessions.filter((x) => !x.series || x.start !== 1440 + 360);
  assert.ok(validate(c, miss).some((v) => v.code === 'series_missing'));
});

// ---------- per-type constraints (אילוצים) ----------
test('type constraints: blocked ranges respected, incl. all-day and cross-midnight', () => {
  const c = cfgWith(TYPICAL);
  const k = c.types.find((t) => t.id === 'cadets2');
  k.blocked = [{ day: 0, from: '00:00', to: '00:00' }, { day: 2, from: '20:00', to: '08:00' }, { day: 3, from: '10:00', to: '16:00' }];
  const r = solve(c, { seed: 3, timeBudgetMs: 1500 });
  checkHard(c, r);
  const bad = [[0, 1440], [2 * 1440 + 1200, 3 * 1440 + 480], [3 * 1440 + 600, 3 * 1440 + 960]];
  for (const s of r.sessions.filter((x) => x.typeId === 'cadets2')) {
    for (const [a, b] of bad) assert.ok(s.end <= a || s.start >= b, `cadets2 at ${s.start}`);
  }
  assert.equal(r.summary.perType.cadets2.scheduled, 14 * 60);
});

test('type constraints: validate catches injected violation; heavy constraints warn', () => {
  const c = cfgWith({ kamas: 10 });
  c.types.find((t) => t.id === 'kamas').blocked = [0, 1, 2, 3].map((day) => ({ day, from: '00:00', to: '00:00' })).concat({ day: 4, from: '00:00', to: '12:00' });
  const r = solve(c, OPTS);
  checkHard(c, r);
  assert.ok(r.summary.perType.kamas.scheduled < 600);
  assert.ok(r.warnings.some((w) => w.includes('קמ"ס') && w.includes('אילוצים')), r.warnings.join('|'));
  const bad = structuredClone(r);
  bad.sessions.push({ id: 'inj', typeId: 'kamas', label: 'קמ"ס', trainerId: 't1', start: 1440 + 600, end: 1440 + 720, fixed: false });
  const v = validate(c, bad).find((x) => x.code === 'blocked');
  assert.ok(v && v.message.includes('קמ"ס'));
});

// ---------- availability by hours ----------
test('legacy days array migrates to all-day availability', () => {
  const n = normalizeConfig({ trainers: [{ id: 't1', name: 'א', days: [1, 3] }] });
  assert.deepEqual(n.trainers[0].availability, { 1: null, 3: null });
  assert.deepEqual(n.trainers[0].days, [1, 3]);
});

test('hour ranges respected; balance proportional to available minutes', () => {
  const c = cfgWith(TYPICAL);
  const rg = { from: '08:00', to: '16:00' };
  c.trainers.push({ id: 't3', name: 'מילואימניקית', availability: { 1: rg, 2: rg, 3: rg, 4: { from: '08:00', to: '14:00' } } });
  const r = solve(c, { seed: 3, timeBudgetMs: 2500 });
  checkHard(c, r);
  const pt = r.summary.perTrainer;
  assert.equal(pt.t3.availableMinutes, 3 * 480 + 360);
  assert.ok(pt.t3.minutes > 0);
  // full-time trainers split evenly; the part-timer gets about her share of available minutes
  assert.ok(Math.abs(pt.t1.minutes - pt.t2.minutes) <= 60, JSON.stringify(weekMins(r)));
  assert.ok(Math.abs(pt.t3.minutes - pt.t3.target) <= 120, JSON.stringify(pt));
});

test('hour ranges: validate catches injected violation; fixed session outside range warns', () => {
  const c = cfgWith(LIGHT, {
    fixed: [{ id: 'fxo', typeId: null, label: 'ביקור', day: 1, start: '18:00', duration: 60, trainerId: 't2' }],
  });
  c.trainers[1].availability = { 0: null, 1: { from: '10:00', to: '16:00' }, 2: null, 3: null, 4: null };
  const r = solve(c, OPTS);
  assert.ok(r.violations.some((v) => v.code === 'unavailable' && v.message.includes('10:00')));
  assert.ok(r.warnings.some((w) => w.includes('אימון קבוע')));
  const c2 = cfgWith(LIGHT);
  c2.trainers[1].availability = { 0: null, 1: { from: '10:00', to: '16:00' }, 2: null, 3: null, 4: null };
  const r2 = solve(c2, OPTS);
  checkHard(c2, r2);
  const bad = structuredClone(r2);
  bad.sessions.push({ id: 'x', typeId: null, label: 'x', trainerId: 't2', start: 1440 + 1080, end: 1440 + 1140, fixed: true });
  assert.ok(validate(c2, bad).some((v) => v.code === 'unavailable'));
});
