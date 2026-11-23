// Exports: print/PDF, PNG (canvas + Web Share), Excel (SheetJS lazy) with CSV fallback
import { DAY_NAMES, typeColor, hhmm, rng, hoursTxt, sessionName, trainerName, toMin } from './ui-common.js';

const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
const FILE_BASE = 'periscope-schedule';

export function exportPrint() { window.print(); }

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------------- rows (shared by Excel/CSV) ---------------- */
function scheduleRows(result, config) {
  const { types, trainers } = config;
  const rows = [];
  for (const s of [...result.sessions].sort((a, b) => a.start - b.start)) {
    const notes = [s.series ? 'סדרות' : s.fixed && 'קבוע', s.short && 'מקוצר', s.offHours && 'מחוץ לשעות המועדפות'].filter(Boolean).join(', ');
    rows.push([DAY_NAMES[Math.floor(s.start / 1440)] ?? '', hhmm(s.start), hhmm(s.end), (s.end - s.start) / 60, sessionName(s, types), trainerName(s.trainerId, trainers), notes]);
  }
  if (result.cleaning) rows.push([DAY_NAMES[Math.floor(result.cleaning.start / 1440)], hhmm(result.cleaning.start), hhmm(result.cleaning.end), (result.cleaning.end - result.cleaning.start) / 60, 'יש"פ + ניקיון', '', '']);
  rows.sort((a, b) => DAY_NAMES.indexOf(a[0]) - DAY_NAMES.indexOf(b[0]) || a[1].localeCompare(b[1]));
  return [['יום', 'התחלה', 'סיום', 'שעות', 'אימון', 'מאמנת', 'הערות'], ...rows];
}
function restRows(result, config) {
  const rows = [['סוג', 'מאמנת', 'יום', 'התחלה', 'סיום']];
  for (const s of result.sleep || []) rows.push(['שינה', trainerName(s.trainerId, config.trainers), DAY_NAMES[Math.floor(s.start / 1440)] ?? '', hhmm(s.start), hhmm(s.end)]);
  if (result.after) rows.push(['אפטר', trainerName(result.after.trainerId, config.trainers), DAY_NAMES[result.after.day] ?? '', hhmm(result.after.start), hhmm(result.after.end)]);
  return rows;
}
function summaryRows(result, config) {
  const rows = [['סוג אימון', 'עדיפות', 'נדרש (ש\')', 'שובץ (ש\')']];
  for (const t of config.types) {
    const p = result.summary?.perType?.[t.id] || { requested: t.hours * 60, scheduled: 0 };    rows.push([t.name, t.priority, p.requested / 60, p.scheduled / 60]);
  }
  if (result.summary?.seriesMinutes) rows.push(['סדרות (לא נספר בדרישות)', '', '', result.summary.seriesMinutes / 60]);
  rows.push([]);
  rows.push(['סה"כ שעות אימון', '', '', (result.summary?.totalMinutes || 0) / 60]);
  rows.push(['ניצול', '', '', Math.round((result.summary?.utilization || 0) * 100) + '%']);
  rows.push([]);
  rows.push(['מאמנת', 'ימים זמינים', '', 'שעות בשבוע']);
  for (const t of config.trainers) {
    const p = result.summary?.perTrainer?.[t.id];
    const m = p?.minutes ?? (result.summary?.perTrainerDay?.[t.id] || []).reduce((a, b) => a + b, 0);
    rows.push([t.name, (t.days || [0, 1, 2, 3, 4]).map(d => DAY_NAMES[d]).join(' '), '', m / 60]);
  }
  if (result.warnings?.length) { rows.push([]); rows.push(['הערות']); result.warnings.forEach(w => rows.push([w])); }
  return rows;
}

function loadScript(src, timeout = 9000) {
  return new Promise((res, rej) => {
    if (window.XLSX) return res(window.XLSX);
    const s = document.createElement('script');
    const t = setTimeout(() => { s.remove(); rej(new Error('timeout')); }, timeout);
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = () => { clearTimeout(t); window.XLSX ? res(window.XLSX) : rej(new Error('no XLSX')); };
    s.onerror = () => { clearTimeout(t); s.remove(); rej(new Error('load failed')); };
    document.head.append(s);
  });
}

export async function exportExcel(result, config) {
  const sched = scheduleRows(result, config);
  try {
    const X = await loadScript(XLSX_URL);
    const wb = X.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    const add = (rows, name, cols) => { const ws = X.utils.aoa_to_sheet(rows); ws['!cols'] = cols.map(w => ({ wch: w })); X.utils.book_append_sheet(wb, ws, name); };
    add(sched, 'לו"ז', [8, 8, 8, 6, 24, 14, 26]);
    add(summaryRows(result, config), 'סיכום', [28, 8, 10, 10]);
    add(restRows(result, config), 'שינה ואפטר', [8, 14, 8, 8, 8]);
    X.writeFile(wb, FILE_BASE + '.xlsx');
    return 'xlsx';
  } catch {
    const csv = sched.map(r => r.map(v => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
    download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), FILE_BASE + '.csv');
    return 'csv';
  }
}

/* ---------------- PNG ---------------- */
function loadImg(src) {
  return new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
}
function chamfer(ctx, x, y, w, h, c) {
  ctx.beginPath(); ctx.moveTo(x + c, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + c); ctx.closePath();
}
function fitText(ctx, txt, maxW) {
  if (ctx.measureText(txt).width <= maxW) return txt;
  let t = txt; while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

export async function renderPNG(result, config) {
  const { types, trainers, rules } = config;
  const F = '"Heebo", Arial, sans-serif';
  try { await Promise.all([document.fonts.load(`800 20px Heebo`), document.fonts.load(`500 16px Heebo`)]); } catch {}
  const W = 1600, headH = 150, dayHeadH = 50, ppm = 0.72, bodyH = 1440 * ppm, axisW = 64, pad = 36, footH = 196;
  const H = headH + dayHeadH + bodyH + footH + pad;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.direction = 'rtl';
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#22384a'); g.addColorStop(1, '#17232d');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(90,167,239,.07)'; ctx.lineWidth = 1;
  for (let r = 100; r < 1600; r += 100) { ctx.beginPath(); ctx.arc(W - 120, 0, r, 0, Math.PI * 2); ctx.stroke(); }

  const logo = await loadImg(new URL('../assets/brand/logo-horizontal.svg', import.meta.url).href);
  if (logo) ctx.drawImage(logo, pad, 34, 365, 80);
  ctx.textAlign = 'right'; ctx.fillStyle = '#eef3f8'; ctx.font = `800 44px ${F}`;
  ctx.fillText('לו"ז אימונים שבועי', W - pad, 76);
  ctx.fillStyle = '#b3c3d2'; ctx.font = `500 22px ${F}`;
  const sm = result.summary || {};
  ctx.fillText(`${hoursTxt(sm.totalMinutes || 0)} שעות אימון · ניצול ${Math.round((sm.utilization || 0) * 100)}% · הופק ${new Date().toLocaleDateString('he-IL')}`, W - pad, 114);
  ctx.fillStyle = '#f0962e'; ctx.fillRect(W - pad - 160, 128, 160, 4);

  const top = headH + dayHeadH, colsW = W - pad * 2 - axisW, colW = colsW / 5, gap = 8;
  const colX = d => W - pad - axisW - (d + 1) * colW; // RTL: Sunday at right
  // axis
  ctx.font = `500 15px ${F}`; ctx.fillStyle = '#8fa3b5'; ctx.textAlign = 'right';
  for (let h = 0; h <= 24; h += 2) ctx.fillText(String(h).padStart(2, '0') + ':00', W - pad - 6, top + h * 60 * ppm + 5);
  const wS = rules.weekStart ?? 600, wE = rules.weekEnd ?? 6600;
  const dayMin = Array(5).fill(0);
  const seg = (st, en, fn) => { for (let d = 0; d < 5; d++) { const a = Math.max(st, d * 1440), b = Math.min(en, (d + 1) * 1440); if (b > a) fn(d, a - d * 1440, b - a); } };
  (result.sessions || []).forEach(s => seg(s.start, s.end, (d, _, l) => dayMin[d] += l));

  for (let d = 0; d < 5; d++) {
    const x = colX(d) + gap / 2, w = colW - gap;
    ctx.fillStyle = '#1a2833'; ctx.fillRect(x, headH, w, dayHeadH - 6);
    ctx.fillStyle = '#2f7fd0'; ctx.fillRect(x, headH + dayHeadH - 8, w, 3);
    ctx.fillStyle = '#eef3f8'; ctx.font = `800 22px ${F}`; ctx.textAlign = 'center';
    ctx.fillText(`${DAY_NAMES[d]}  ·  ${hoursTxt(dayMin[d])} ש'`, x + w / 2, headH + 30);
    ctx.fillStyle = '#172530'; ctx.fillRect(x, top, w, bodyH);
    for (let h = 0; h <= 24; h++) { ctx.fillStyle = h % 2 ? 'rgba(126,168,204,.07)' : 'rgba(126,168,204,.18)'; ctx.fillRect(x, top + h * 60 * ppm, w, 1); }
    const ds = d * 1440, de = ds + 1440;
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    if (wS > ds) ctx.fillRect(x, top, w, (Math.min(wS, de) - ds) * ppm);
    if (wE < de) ctx.fillRect(x, top + (Math.max(wE, ds) - ds) * ppm, w, (de - Math.max(wE, ds)) * ppm);
  }
  const laneW = 9, tIdx = Object.fromEntries(trainers.map((t, i) => [t.id, i]));
  const lane = (d, s, l, i, color, striped) => {
    const x = colX(d) + gap / 2 + i * (laneW + 2) + 2;
    ctx.fillStyle = color; ctx.fillRect(x, top + s * ppm, laneW, l * ppm);
    if (striped) { ctx.fillStyle = 'rgba(0,0,0,.35)'; for (let y = 0; y < l * ppm; y += 8) ctx.fillRect(x, top + s * ppm + y, laneW, 3); }
  };
  trainers.forEach((t, i) => (t.days ? [0, 1, 2, 3, 4].filter(d => !t.days.includes(d)) : []).forEach(d => lane(d, 0, 1440, i, '#0b131a', false)));
  (result.sleep || []).forEach(sl => seg(sl.start, sl.end, (d, s, l) => lane(d, s, l, tIdx[sl.trainerId] ?? 0, '#4f6b84', true)));
  if (result.after?.start != null) seg(result.after.start, result.after.end, (d, s, l) => lane(d, s, l, tIdx[result.after.trainerId] ?? 0, '#f0962e', true));

  const block = (d, s, l, fill, lines, textColor = '#0e1a24') => {
    const x = colX(d) + gap / 2 + trainers.length * (laneW + 2) + 6, w = colW - gap - trainers.length * (laneW + 2) - 8;
    const y = top + s * ppm + 1, h = l * ppm - 2;
    ctx.fillStyle = fill; chamfer(ctx, x, y, w, h, 8); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.fillStyle = textColor; ctx.textAlign = 'right';
    lines.forEach((ln, i) => { if ((i + 1) * 19 + 4 > h && i > 0) return; ctx.font = `${i === 0 ? 800 : 500} ${i === 0 ? 17 : 15}px ${F}`; ctx.fillText(fitText(ctx, ln, w - 14), x + w - 8, y + 19 + i * 18); });
    ctx.restore();
  };
  if (result.cleaning) seg(result.cleaning.start, result.cleaning.end, (d, s, l) => block(d, s, l, '#5d7387', ['יש"פ + ניקיון'], '#fff'));
  for (const s of result.sessions || []) {
    const nm = sessionName(s, types) + (s.short ? ' (1.5)' : '') + (s.fixed ? ' 📌' : '');
    seg(s.start, s.end, (d, st, l) => block(d, st, l, typeColor(s.typeId, types), [nm, `${rng(s.start, s.end)}`, trainerName(s.trainerId, trainers)]));
  }
  // footer: per type
  let fx = W - pad, fy = top + bodyH + 46, rows = 1;
  ctx.textAlign = 'right';
  const footItems = [...types].sort((a, b) => a.priority - b.priority).map(t => [t.id, t.name, sm.perType?.[t.id]]).filter(x => x[2] && x[2].requested);
  if (sm.seriesMinutes) footItems.unshift(['series', 'סדרות', null]);
  for (const [id, name, p] of footItems) {
    const t = { id };
    const txt = p ? `${name}  ${hoursTxt(p.scheduled)}/${hoursTxt(p.requested)} ש'` : `${name}  ${hoursTxt(sm.seriesMinutes)} ש'`;
    ctx.font = `700 20px ${F}`; const tw = ctx.measureText(txt).width;
    if (fx - tw - 40 < pad) { if (rows >= 2) break; rows++; fx = W - pad; fy += 34; }
    ctx.fillStyle = typeColor(t.id, types); ctx.fillRect(fx - 16, fy - 15, 16, 16);
    ctx.fillStyle = '#eef3f8'; ctx.fillText(txt, fx - 26, fy);
    fx -= tw + 64;
  }
  ctx.fillStyle = '#b3c3d2'; ctx.font = `500 17px ${F}`;
  const tmin = id => sm.perTrainer?.[id]?.minutes ?? (sm.perTrainerDay?.[id] || []).reduce((a, b) => a + b, 0);
  ctx.fillText(fitText(ctx, `מאמנות: ${trainers.map(t => `${t.name} ${hoursTxt(tmin(t.id))} ש'`).join(' · ')}   |   פס צד מפוספס: שינה (כחול), אפטר (כתום), לא זמינה (כהה)`, W - pad * 2), W - pad, fy + 44);
  const warn = (result.warnings || [])[0];
  if (warn) { ctx.fillStyle = '#ffc56b'; ctx.fillText(fitText(ctx, '⚠ ' + warn, W - pad * 2), W - pad, fy + 78); }
  return new Promise(res => cv.toBlob(res, 'image/png'));
}

export async function exportPNG(result, config) {
  const blob = await renderPNG(result, config);
  const file = new File([blob], FILE_BASE + '.png', { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'לו"ז אימונים שבועי' }); return 'shared'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  download(blob, file.name);
  return 'downloaded';
}
