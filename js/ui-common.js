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
export function timeOptions(from = 0, to = 1410, step = 30) {
  const out = [];
  for (let m = from; m <= to; m += step) out.push(m === 1440 ? '24:00' : hhmm(m));
  return out;
}

// time range kept left-to-right inside RTL text (LRI … PDI isolate)
export const rng = (a, b) => '\u2066' + hhmm(a) + '–' + hhmm(b) + '\u2069';
