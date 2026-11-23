import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve, validate, DEFAULT_CONFIG, fmt, dayOf, parseHM } from '../js/engine.js';

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
  for (const tr of cfg.trainers) {
    const sl = r.sleep.filter((z) => z.trainerId === tr.id);
    assert.equal(sl.length, 4);
    sl.forEach((z) => {
      const n = Math.floor((z.start - 720) / 1440); // night index (start in [20:00, 04:00])
      assert.ok(z.start >= n * 1440 + parseHM(R.sleepWindowStart), 'sleep start');
      assert.ok(z.end <= (n + 1) * 1440 + parseHM(R.sleepWindowEnd), 'sleep end');
      assert.equal(z.end - z.start, R.sleepMinutes);
    });
  }
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
});

test('overload: priorities respected', () => {
  const c = cfgWith(OVER);
  const r = solve(c, { seed: 5, timeBudgetMs: 1500 });
  checkHard(c, r);
  const order = [...c.types].sort((a, b) => a.priority - b.priority);
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
