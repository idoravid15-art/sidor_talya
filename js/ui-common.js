// Shared UI helpers (no engine logic here)
export const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי'];
export const DAY_SHORT = ["א'", "ב'", "ג'", "ד'", "ה'"];

export const SERIES_ID = 'series';
export const TYPE_COLORS = {
  series: '#f2a0c4',
  maamanot: '#86bdf2',
  kamas: '#f4b26a',
  cadets2: '#7fd3b1',
  officersQual: '#c6b2f2',
  cadetsQual: '#e7d47e',
};
export const CUSTOM_COLOR = '#c5d0da';
const EXTRA = ['#9fd0e8', '#f2a3b8', '#b5d97a', '#e3b38f'];

export function typeColor(typeId, types = []) {
  if (!typeId) return CUSTOM_COLOR;
  if (TYPE_COLORS[typeId]) return TYPE_COLORS[typeId];
  const i = types.findIndex(t => t.id === typeId);
  return EXTRA[(i < 0 ? 0 : i) % EXTRA.length];
}

export const toMin = hhmm => {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
export const hhmm = min => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
};
export const hoursTxt = min => {
  const h = Math.round(min / 30) / 2;
  return (Number.isInteger(h) ? String(h) : h.toFixed(1)) ;
};
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function sessionName(s, types) {
  if (s.label) return s.label;
  const t = types.find(t => t.id === s.typeId);
  return t ? t.name : 'אימון';
}
export function trainerName(id, trainers) {
  const t = trainers.find(t => t.id === id);
  return t ? t.name : '';
}
// trainer availability { [day]: null (all day) | {from, to} }; legacy `days` arrays become all-day entries
export function availMap(t) {
  if (t && t.availability && typeof t.availability === 'object') return t.availability;
  const ds = Array.isArray(t?.days) ? t.days : [0, 1, 2, 3, 4];
  return Object.fromEntries(ds.map(d => [d, null]));
}
export const availDays = t => Object.keys(availMap(t)).map(Number).filter(d => d >= 0 && d <= 4).sort();
export const CROSS_MAX = 240; // ranges may continue past midnight until 04:00
export const isCross = r => !!r && (toMin(r.to) || 1440) <= toMin(r.from);
// absolute [start, end) intervals; a range with to < from ends on the next day
export function availIntervals(t) {
  const m = availMap(t);
  return Object.keys(m).map(Number).map(d => {
    const r = m[d], base = d * 1440;
    if (!r) return [base, base + 1440];
    const a = toMin(r.from), b = toMin(r.to) || 1440;
    return [base + a, base + (b > a ? b : 1440 + b)];
  }).sort((x, y) => x[0] - y[0]);
}
// unavailable [start, length] segments (minutes of day) for day d (ranges from the previous night included)
export function offSegments(t, d) {
  const lo = d * 1440, hi = lo + 1440;
  const iv = availIntervals(t).map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = []; let cur = lo;
  for (const [a, b] of iv) { if (a > cur) out.push([cur - lo, a - cur]); cur = Math.max(cur, b); }
  if (cur < hi) out.push([cur - lo, hi - cur]);
  return out;
}
export const availText = (t, d) => { const r = availMap(t)[d]; return r ? `${r.from}-${r.to}${isCross(r) ? ' (למחרת)' : ''}` : 'כל היום'; };
export function timeOptions(from = 0, to = 1410, step = 30) {
  const out = [];
  for (let m = from; m <= to; m += step) out.push(m === 1440 ? '24:00' : hhmm(m));
  return out;
}

// time range kept left-to-right inside RTL text (LRI … PDI isolate)
export const rng = (a, b) => '\u2066' + hhmm(a) + '–' + hhmm(b) + '\u2069';
