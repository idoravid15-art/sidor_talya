// Weekly board renderer (DOM). Desktop: 5 day columns + time axis. Mobile: swipe/tabs per day.
import { DAY_NAMES, typeColor, hhmm, rng, hoursTxt, esc, sessionName, trainerName, toMin } from './ui-common.js';

const DAY = 1440;

// split [start,end) into per-day segments
function segments(start, end, weekStart, weekEnd) {
  const out = [];
  const s0 = Math.max(start, weekStart - DAY), e0 = Math.min(end, weekEnd + DAY);
  for (let d = Math.floor(s0 / DAY); d * DAY < e0; d++) {
    if (d < 0 || d > 4) continue;
    const a = Math.max(s0, d * DAY), b = Math.min(e0, (d + 1) * DAY);
    if (b > a) out.push({ day: d, s: a - d * DAY, d: b - a, contTop: a > start, contBottom: b < end });
  }
  return out;
}

const laneTag = t => t.name.trim().split(/\s+/).pop().slice(0, 1);

export function renderLegend(el, config) {
  const items = [...config.types].sort((a, b) => a.priority - b.priority).filter(t => t.hours > 0 || (config.fixed || []).some(f => f.typeId === t.id)).map(t =>
    `<li><span class="sw" style="background:${typeColor(t.id, config.types)}"></span>${esc(t.name)}</li>`);
  if (config.series?.enabled) items.push(`<li><span class="sw" style="background:${typeColor('series')}"></span>סדרות</li>`);
  items.push(`<li><span class="sw" style="background:${typeColor(null)}"></span>אחר</li>`);
  items.push(`<li><span class="sw sw-clean"></span>יש"פ + ניקיון</li>`);
  items.push(`<li><span class="sw sw-sleep"></span>שינה (פס צד)</li>`);
  items.push(`<li><span class="sw sw-after"></span>אפטר (פס צד)</li>`);
  if (config.trainers.some(t => t.days && t.days.length < 5)) items.push(`<li><span class="sw sw-unavail"></span>לא זמינה (פס צד)</li>`);
  items.push(`<li><span class="flag">${config.trainers.map(t => esc(laneTag(t))).join(' ')}</span> פסי צד לפי מאמנת: ${config.trainers.map(t => esc(t.name)).join(', ')}</li>`);
  items.push(`<li><span class="sw sw-window"></span>חלון חמישי</li>`);
  items.push(`<li><span class="flag">1.5</span> מקוצר</li><li><span class="flag">📌</span> קבוע</li><li><span class="flag">☾</span> מחוץ לשעות</li>`);
  el.innerHTML = items.join('');
}

export function renderBoard(boardEl, tabsEl, result, config) {
  const { types, trainers, rules } = config;
  const wS = rules.weekStart ?? 600, wE = rules.weekEnd ?? 6600;
  const prefS = toMin(rules.preferredStart ?? '06:00');
  const prefE = toMin(rules.preferredEnd ?? '24:00') || 1440;
  const tIdx = Object.fromEntries(trainers.map((t, i) => [t.id, i]));
  const cols = Array.from({ length: 5 }, () => ({ blocks: [], lanes: trainers.map(() => []) }));
  const dayMin = Array(5).fill(0);

  for (const s of result.sessions || []) {
    const name = sessionName(s, types);
    const tn = trainerName(s.trainerId, trainers);
    const c = typeColor(s.typeId, types);
    const full = `${name}, ${rng(s.start, s.end)}, ${tn}${s.short ? ', מקוצר' : ''}${s.series ? ', סדרות' : s.fixed ? ', קבוע' : ''}${s.offHours ? ', מחוץ לשעות המועדפות' : ''}`;
    for (const g of segments(s.start, s.end, wS, wE)) {
      dayMin[g.day] += g.d;
      const flags = [s.short && '<span class="flag" aria-hidden="true">1.5</span>', s.fixed && !s.series && '<span class="flag" aria-hidden="true">📌</span>', s.offHours && '<span class="flag" aria-hidden="true">☾</span>'].filter(Boolean).join('');
      cols[g.day].blocks.push(`<div class="blk t${(tIdx[s.trainerId] ?? 0) + 1}${g.contTop ? ' cont-top' : ''}" role="listitem" style="--s:${g.s};--d:${g.d};--c:${c}" title="${esc(full)}">
        <span class="sr-only">${esc(full)}</span>
        <span aria-hidden="true"><span class="flags">${flags}</span><span class="bt">${esc(name)}</span><span class="bm">${rng(s.start, s.end)}</span><span class="bm tr">${esc(tn)}</span></span></div>`);
    }
  }
  if (result.cleaning) {
    const { start, end } = result.cleaning;
    for (const g of segments(start, end, wS, wE)) cols[g.day].blocks.push(
      `<div class="blk blk-clean" role="listitem" style="--s:${g.s};--d:${g.d}"><span class="bt">יש"פ + ניקיון</span><span class="bm">${rng(start, end)}</span></div>`);
  }
  const tw = rules.thursdayWindow;
  if (tw && tw.enabled && result.thursdayWindowKept) {
    const st = (tw.day ?? 4) * DAY + toMin(tw.start);
    for (const g of segments(st, st + (tw.duration || 30), wS, wE)) cols[g.day].blocks.push(
      `<div class="blk blk-window" role="listitem" style="--s:${g.s};--d:${g.d}">חלון פנוי ${hhmm(st)}</div>`);
  }
  for (const sl of result.sleep || []) {
    const i = tIdx[sl.trainerId]; if (i == null) continue;
    const lbl = `שינה ${trainerName(sl.trainerId, trainers)} ${rng(sl.start, sl.end)}`;
    for (const g of segments(sl.start, sl.end, wS, wE)) cols[g.day].lanes[i].push(
      `<div class="sleep" role="listitem" style="top:calc(${g.s}px * var(--ppm));height:calc(${g.d}px * var(--ppm))" title="${esc(lbl)}"><span class="sr-only">${esc(lbl)}</span></div>`);
  }
  trainers.forEach((t, i) => {
    if (!t.days) return;
    for (let d = 0; d < 5; d++) if (!t.days.includes(d)) cols[d].lanes[i].unshift(
      `<div class="unavail" role="listitem" title="${esc(t.name)} לא זמינה ביום ${DAY_NAMES[d]}"><span class="sr-only">${esc(t.name)} לא זמינה ביום ${DAY_NAMES[d]}</span></div>`);
  });
  if (result.after && result.after.start != null) {
    const a = result.after, i = tIdx[a.trainerId];
    if (i != null) {
      const lbl = `אפטר ${trainerName(a.trainerId, trainers)} ${rng(a.start, a.end)}`;
      for (const g of segments(a.start, a.end, wS, wE)) cols[g.day].lanes[i].push(
        `<div class="afterbar" role="listitem" style="top:calc(${g.s}px * var(--ppm));height:calc(${g.d}px * var(--ppm))" title="${esc(lbl)}"><span class="sr-only">${esc(lbl)}</span></div>`);
    }
  }

  const axis = [];
  for (let h = 0; h <= 24; h += 2) axis.push(`<span style="top:calc(${h * 60}px * var(--ppm))">${String(h).padStart(2, '0')}:00</span>`);

  const days = cols.map((c, d) => {
    const ds = d * DAY, de = ds + DAY;
    const closed = [];
    if (wS > ds) closed.push([0, Math.min(wS, de) - ds]);
    if (wE < de) closed.push([Math.max(wE, ds) - ds, de - Math.max(wE, ds)]);
    const shade = [];
    if (prefS > 0) shade.push([0, prefS]);
    if (prefE < 1440) shade.push([prefE, 1440 - prefE]);
    return `<section class="day" id="day-${d}" aria-labelledby="dh-${d}" data-day="${d}">
      <div class="day-head"><b id="dh-${d}">${DAY_NAMES[d]}</b><small>${hoursTxt(dayMin[d])} ש' אימון</small></div>
      <div class="day-body">
        ${shade.map(([s, l]) => `<div class="offhours" style="top:calc(${s}px * var(--ppm));height:calc(${l}px * var(--ppm))"></div>`).join('')}
        ${closed.map(([s, l]) => `<div class="closed" style="top:calc(${s}px * var(--ppm));height:calc(${l}px * var(--ppm))">מחוץ לשבוע</div>`).join('')}
        <div class="main-lane" role="list" aria-label="אימונים ביום ${DAY_NAMES[d]}">${c.blocks.join('')}</div>
        <div class="lanes">${c.lanes.map((l, i) => `<div class="lane" role="list" aria-label="שינה ואפטר: ${esc(trainers[i].name)}"><span class="lane-tag" aria-hidden="true">${esc(laneTag(trainers[i]))}</span>${l.join('')}</div>`).join('')}</div>
      </div></section>`;
  }).join('');

  boardEl.style.setProperty('--nl', trainers.length);
  boardEl.innerHTML = `<div class="axis" aria-hidden="true"><div class="axis-in">${axis.join('')}</div></div><div class="days" id="days">${days}</div>`;

  // mobile tabs
  tabsEl.innerHTML = DAY_NAMES.map((n, d) =>
    `<button type="button" class="day-tab" role="tab" id="tab-${d}" aria-controls="day-${d}" aria-selected="${d === 0}" tabindex="${d === 0 ? 0 : -1}">${n}<small>${hoursTxt(dayMin[d])} ש'</small></button>`).join('');
  const daysEl = boardEl.querySelector('#days');
  const tabs = [...tabsEl.querySelectorAll('.day-tab')];
  const select = (d, focus) => {
    tabs.forEach((t, i) => { t.setAttribute('aria-selected', i === d); t.tabIndex = i === d ? 0 : -1; });
    if (focus) tabs[d].focus();
  };
  tabs.forEach((t, d) => {
    t.addEventListener('click', () => {
      select(d);
      const col = daysEl.children[d];
      col.scrollIntoView({ block: 'nearest', inline: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
    t.addEventListener('keydown', e => {
      const k = e.key; let n = d;
      if (k === 'ArrowLeft') n = Math.min(4, d + 1); else if (k === 'ArrowRight') n = Math.max(0, d - 1);
      else if (k === 'Home') n = 0; else if (k === 'End') n = 4; else return;
      e.preventDefault(); tabs[n].click(); select(n, true);
    });
  });
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(es => {
      for (const e of es) if (e.isIntersecting && e.intersectionRatio > .6) select(+e.target.dataset.day);
    }, { root: daysEl, threshold: [.6] });
    [...daysEl.children].forEach(c => io.observe(c));
  }
}
