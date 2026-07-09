// Deterministic level derivation per PRD. This exact function body is embedded
// in the "Compute Levels" Code node — keep it dependency-free, plain ES2020.
// Data source in production: Yahoo chart API (FMP free tier 402s on micro-cap
// symbols); bar shape is normalized to the format below before this runs.
//
// Inputs:
//   daily: ascending [{date:'YYYY-MM-DD', open, high, low, close, volume}]
//   intraday: ascending [{date:'YYYY-MM-DD HH:mm:ss', open, high, low, close, volume}] (ET timestamps)
//   todayET: 'YYYY-MM-DD'
//   quote: optional live-quote fallback for the premarket range, used when the
//          bar feed lacks today's premarket (the production Polygon plan 403s on
//          same-day intraday). { quoteHigh, quoteLow, isPremarket }. During
//          premarket the Finnhub quote's session high/low IS the premarket range.
// Output: levels object (all numbers rounded to 2dp)

function computeLevels(daily, intraday, todayET, quote) {
  const r2 = (x) => Math.round(x * 100) / 100;
  const q = quote || {};
  const quoteHigh = Number(q.quoteHigh) > 0 ? Number(q.quoteHigh) : null;
  const quoteLow = Number(q.quoteLow) > 0 ? Number(q.quoteLow) : null;
  const isPremarket = !!q.isPremarket;

  // ---- split intraday into premarket (today, <09:30 ET) and sessions ----
  const todayBars = intraday.filter((b) => b.date.slice(0, 10) === todayET);
  const pmBars = todayBars.filter((b) => b.date.slice(11, 16) < '09:30');
  let pmHigh = pmBars.length ? Math.max(...pmBars.map((b) => b.high)) : null;
  let pmLow = pmBars.length ? Math.min(...pmBars.map((b) => b.low)) : null;
  const pmVolume = pmBars.reduce((s, b) => s + (b.volume || 0), 0);
  // blend the live quote's premarket range when the bar feed has no today PM bars
  let pmFromQuote = false;
  if (isPremarket && quoteHigh !== null && (pmHigh === null || quoteHigh > pmHigh)) { pmHigh = quoteHigh; pmFromQuote = true; }
  if (isPremarket && quoteLow !== null && (pmLow === null || quoteLow < pmLow)) { pmLow = quoteLow; }

  // most recent completed regular session = last daily bar strictly before today
  const priorDaily = daily.filter((b) => b.date < todayET);
  const lastSession = priorDaily.length ? priorDaily[priorDaily.length - 1] : null;
  const lastSessionHigh = lastSession ? lastSession.high : null;

  // ---- TRIGGER: premarket high, or last regular-session HOD if above it ----
  let trigger = null;
  if (pmHigh !== null && lastSessionHigh !== null) trigger = Math.max(pmHigh, lastSessionHigh);
  else trigger = pmHigh !== null ? pmHigh : lastSessionHigh;
  if (trigger === null) return null; // no data at all

  // ---- CONFIRM: nearest prior reclaimed resistance below trigger ----
  // pivot high = daily high greater than the highs of the 2 bars either side;
  // "reclaimed" = some later daily close above the pivot high.
  const pivots = [];
  for (let i = 2; i < priorDaily.length - 2; i++) {
    const h = priorDaily[i].high;
    if (
      h > priorDaily[i - 1].high && h > priorDaily[i - 2].high &&
      h > priorDaily[i + 1].high && h > priorDaily[i + 2].high
    ) {
      const reclaimed = priorDaily.slice(i + 1).some((b) => b.close > h);
      if (reclaimed && h < trigger) pivots.push(h);
    }
  }
  let confirm = pivots.length ? Math.max(...pivots) : null;
  // on a large overnight gap the prior pivots sit far below the premarket
  // trigger; prefer the premarket low when it is a tighter (higher) invalidation
  // so the confirm tracks today's action rather than an ancient pivot
  if (pmLow !== null && pmLow < trigger && (confirm === null || pmLow > confirm)) confirm = pmLow;
  // fallback chain (still deterministic): prior close if below trigger, else premarket low
  if (confirm === null && lastSession && lastSession.close < trigger) confirm = lastSession.close;
  if (confirm === null && pmLow !== null && pmLow < trigger) confirm = pmLow;
  if (confirm === null) confirm = r2(trigger * 0.9);
  // snap to half/whole dollar when within 2%
  const snaps = [Math.round(confirm * 2) / 2, Math.round(confirm)];
  for (const s of snaps) {
    if (s > 0 && s < trigger && Math.abs(s - confirm) / confirm <= 0.02) { confirm = s; break; }
  }

  // ---- RANGE: nearest daily anchor above trigger ----
  // priority: daily 200MA, origin of most recent gap down, prior multi-day shelf
  const closes = daily.map((b) => b.close);
  let ma200 = null;
  if (closes.length >= 200) {
    ma200 = closes.slice(-200).reduce((s, c) => s + c, 0) / 200;
  }
  // gap-down origin: most recent day whose open < prev close * 0.98; origin = that prev close
  let gapOrigin = null;
  for (let i = priorDaily.length - 1; i > 0; i--) {
    if (priorDaily[i].open < priorDaily[i - 1].close * 0.98) {
      gapOrigin = priorDaily[i - 1].close;
      break;
    }
  }
  // shelf: >=3 consecutive prior days with highs within a 5% band; level = band max
  let shelf = null;
  for (let i = priorDaily.length - 3; i >= 0; i--) {
    const w = priorDaily.slice(i, i + 3);
    const hi = Math.max(...w.map((b) => b.high));
    const lo = Math.min(...w.map((b) => b.high));
    if ((hi - lo) / hi <= 0.05 && hi > trigger && (shelf === null || hi < shelf)) shelf = hi;
  }
  const anchors = [];
  if (ma200 !== null && ma200 > trigger) anchors.push({ level: ma200, name: 'daily 200MA' });
  if (gapOrigin !== null && gapOrigin > trigger) anchors.push({ level: gapOrigin, name: 'gap fill' });
  if (shelf !== null) anchors.push({ level: shelf, name: 'prior shelf' });

  let rangeLow, rangeHigh, rangeAnchor, openEnded;
  const cap = trigger * 1.2;
  const inReach = anchors.filter((a) => a.level <= cap);
  if (inReach.length) {
    // priority order as listed, not nearest: 200MA > gap fill > shelf (PRD priority)
    const chosen = inReach[0];
    rangeLow = r2(chosen.level);
    rangeAnchor = chosen.name;
    const above = anchors.filter((a) => a.level > chosen.level).map((a) => a.level);
    rangeHigh = above.length ? r2(Math.min(...above)) : Math.ceil(chosen.level); // next anchor, else round number
    if (rangeHigh <= rangeLow) rangeHigh = Math.ceil(rangeLow);
    if (rangeHigh === rangeLow) rangeHigh = rangeLow + 1;
    openEnded = false;
  } else {
    // no daily resistance within +20% -> open-ended target at +20%, marked "+"
    rangeLow = r2(cap);
    rangeHigh = null;
    rangeAnchor = 'no daily resistance within 20%';
    openEnded = true;
  }

  // level-structure stats for the grading facts block
  const respects = priorDaily.filter((b) => b.low <= confirm * 1.01 && b.close >= confirm).length;

  return {
    trigger: r2(trigger),
    confirm: r2(confirm),
    invalidation: r2(confirm),
    rangeLow,
    rangeHigh,
    rangeAnchor,
    openEnded,
    pmHigh: pmHigh !== null ? r2(pmHigh) : null,
    pmLow: pmLow !== null ? r2(pmLow) : null,
    pmVolume,
    confirmRespectCount: respects,
    triggerToConfirmPct: r2(((trigger - confirm) / trigger) * 100),
    dataQuality: pmFromQuote ? 'bars+quote-pm' : 'bars',
  };
}

// ---------------- tests ----------------
function mkDaily(spec) {
  // spec: array of [high, low, close, open?]
  let d = new Date('2026-01-05');
  return spec.map(([high, low, close, open]) => {
    const date = d.toISOString().slice(0, 10);
    d = new Date(d.getTime() + 86400000 * (d.getDay() === 5 ? 3 : 1));
    return { date, open: open ?? (high + low) / 2, high, low, close, volume: 1e6 };
  });
}

let failures = 0;
function check(name, cond, detail) {
  if (!cond) { failures++; console.log(`FAIL ${name}: ${detail}`); }
  else console.log(`ok   ${name}`);
}

// Case 1: classic gapper. Prior sessions around $2, pivot at 2.40 reclaimed, premarket high 2.45.
{
  const daily = mkDaily([
    [2.1, 1.9, 2.0], [2.2, 2.0, 2.1], [2.4, 2.1, 2.2], [2.3, 2.1, 2.15], [2.25, 2.0, 2.1],
    [2.5, 2.2, 2.45], [2.45, 2.25, 2.3], [2.35, 2.15, 2.2], [2.3, 2.1, 2.15], [2.25, 2.05, 2.1],
  ]);
  const today = '2026-01-20';
  const intraday = [
    { date: '2026-01-20 07:00:00', open: 2.2, high: 2.35, low: 2.15, close: 2.3, volume: 50000 },
    { date: '2026-01-20 07:30:00', open: 2.3, high: 2.45, low: 2.28, close: 2.4, volume: 80000 },
  ];
  const lv = computeLevels(daily, intraday, today);
  check('c1 trigger=pmHigh', lv.trigger === 2.45, JSON.stringify(lv));
  check('c1 confirm below trigger', lv.confirm < lv.trigger, JSON.stringify(lv));
  check('c1 pm stats', lv.pmHigh === 2.45 && lv.pmLow === 2.15 && lv.pmVolume === 130000, JSON.stringify(lv));
  check('c1 openEnded (no anchors above)', lv.openEnded === true, JSON.stringify(lv));
  check('c1 range = +20%', Math.abs(lv.rangeLow - 2.94) < 0.01, JSON.stringify(lv));
}

// Case 2: prior session high above premarket high -> trigger = session high.
{
  const daily = mkDaily([
    [3.0, 2.5, 2.8], [3.2, 2.7, 3.0], [3.5, 3.0, 3.4], [3.4, 3.0, 3.1], [5.0, 3.2, 4.8],
  ]);
  const today = '2026-01-12';
  const intraday = [
    { date: '2026-01-12 08:00:00', open: 4.8, high: 4.9, low: 4.6, close: 4.85, volume: 10000 },
  ];
  const lv = computeLevels(daily, intraday, today);
  check('c2 trigger=session HOD', lv.trigger === 5.0, JSON.stringify(lv));
}

// Case 3: gap-down origin above trigger within 20% -> range anchored at gap fill.
{
  const spec = [];
  // long base near 10, then gap down to 6, recover to 5.5-6.5 zone
  for (let i = 0; i < 10; i++) spec.push([10.2, 9.8, 10.0]);
  spec.push([6.5, 5.8, 6.0, 6.0]); // gap-down day: open 6.0 < prev close 10 * .98
  for (let i = 0; i < 5; i++) spec.push([6.4, 5.9, 6.2]);
  const daily = mkDaily(spec);
  const today = daily[daily.length - 1].date;
  const dailyPrior = daily.slice(0, -1);
  const intraday = [
    { date: `${today} 08:00:00`, open: 6.2, high: 6.6, low: 6.1, close: 6.5, volume: 20000 },
  ];
  const lv = computeLevels(dailyPrior, intraday, today);
  check('c3 trigger', lv.trigger === 6.6, JSON.stringify(lv));
  // gap origin 10.0 sits >20% above the 6.6 trigger (cap 7.92) and the 6.4 shelf is
  // below the trigger, so the correct PRD outcome is open-ended at +20%.
  check('c3 openEnded at +20%', lv.openEnded === true && Math.abs(lv.rangeLow - 7.92) < 0.01, JSON.stringify(lv));
}

// Case 4: 200MA above trigger and within 20%.
{
  const spec = [];
  for (let i = 0; i < 210; i++) spec.push([11.0, 10.6, 10.8]); // MA200 ~ 10.8
  for (let i = 0; i < 6; i++) spec.push([10.0, 9.4, 9.6]); // recent dip
  const daily = mkDaily(spec);
  const today = '2026-12-31';
  const intraday = [
    { date: '2026-12-31 08:00:00', open: 9.7, high: 10.1, low: 9.6, close: 10.0, volume: 30000 },
  ];
  const lv = computeLevels(daily, intraday, today);
  check('c4 anchor is 200MA', lv.rangeAnchor === 'daily 200MA', JSON.stringify(lv));
  check('c4 rangeLow ~10.77', Math.abs(lv.rangeLow - 10.77) < 0.15, JSON.stringify(lv));
}

// Case 5: no intraday data at all (03:50 use case) -> trigger from last session.
{
  const daily = mkDaily([[2.1, 1.9, 2.0], [2.6, 2.0, 2.5], [2.8, 2.4, 2.7]]);
  const lv = computeLevels(daily, [], '2026-01-08');
  check('c5 trigger from daily', lv.trigger === 2.8, JSON.stringify(lv));
  check('c5 confirm=prior close', lv.confirm === 2.7, JSON.stringify(lv));
}

// Case 6: confirm snapping to half dollar.
{
  const daily = mkDaily([
    [2.0, 1.8, 1.9], [2.2, 1.9, 2.0], [2.52, 2.2, 2.4], [2.4, 2.2, 2.3], [2.45, 2.2, 2.55],
    [2.6, 2.3, 2.5], [2.5, 2.3, 2.4],
  ]);
  // pivot at 2.52 (bars around lower), reclaimed by close 2.55; snap 2.52 -> 2.5 (within 2%)
  const today = '2026-01-14';
  const intraday = [{ date: '2026-01-14 08:00:00', open: 2.6, high: 3.1, low: 2.55, close: 3.0, volume: 90000 }];
  const lv = computeLevels(daily, intraday, today);
  check('c6 confirm snapped to 2.5', lv.confirm === 2.5, JSON.stringify(lv));
}

// Case 7: overnight gapper with NO today premarket bars (Polygon plan 403s on
// same-day intraday) — the live Finnhub quote supplies the premarket range. The
// trigger must reflect the premarket high (5.20), not yesterday's high (3.00),
// so a name already trading at $4.80 is not handed a stale $3 breakout level.
{
  const daily = mkDaily([
    [2.6, 2.3, 2.5], [2.8, 2.5, 2.7], [3.0, 2.7, 2.9], [2.95, 2.6, 2.75], [2.9, 2.55, 2.7],
  ]);
  const today = '2026-01-21';
  const noPmBars = []; // plan returns nothing for today
  const lv = computeLevels(daily, noPmBars, today, { quoteHigh: 5.2, quoteLow: 4.3, isPremarket: true });
  check('c7 trigger=quote premarket high', lv.trigger === 5.2, JSON.stringify(lv));
  check('c7 trigger above prior high', lv.trigger > 3.0, JSON.stringify(lv));
  check('c7 confirm below trigger', lv.confirm < lv.trigger && lv.confirm > 0, JSON.stringify(lv));
  check('c7 dataQuality flagged', lv.dataQuality === 'bars+quote-pm', JSON.stringify(lv));
  // without the quote (or outside premarket) it falls back to the stale prior
  // session high (2.9) — far below the real premarket price, the bug we fixed
  const stale = computeLevels(daily, noPmBars, today);
  check('c7 no-quote falls to prior high', stale.trigger === 2.9 && stale.dataQuality === 'bars', JSON.stringify(stale));
}

console.log(failures ? `\n${failures} FAILURES` : '\nall tests passed');
process.exit(failures ? 1 : 0);
