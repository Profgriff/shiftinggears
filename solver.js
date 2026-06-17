// solver.js — ROC Shift Scheduler (production build)
//
// Generates a fair, coverage-satisfying monthly shift schedule per department.
//
// BUG FIXED: canAssign() priorFinalState comparison now correctly compares
//   shift *codes* (dept.day_code / dept.night_code) rather than the string
//   literals 'day' / 'night'.  The original code stored lastShift as 'day'
//   or 'night' strings but then compared prevCode (which is the actual code,
//   e.g. 'N' or 'NC') — meaning the night→day rest rule was never enforced
//   across month boundaries.
//
// IMPROVEMENT: improveBalance() now also considers night and weekend
//   counts when selecting candidates for the swap (not just total), which
//   avoids thrashing between two staff who differ only in night/weekend counts.

const OFF   = 'O';
const LEAVE = 'L';

export function daysInMonth(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

export function dateStr(yyyymm, day) {
  const [y, m] = yyyymm.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isWeekend(yyyymm, day) {
  const [y, m] = yyyymm.split('-').map(Number);
  const dow = new Date(y, m - 1, day).getDay();
  return dow === 0 || dow === 6;
}

/**
 * @param {Object} params
 * @param {string} params.month
 * @param {Object} params.department  { id, day_code, night_code, day_min, night_min }
 * @param {Array}  params.staff       [{ id, name }]
 * @param {Object} params.leaveByStaff  { [staffId]: Set<dateStr> }
 * @param {Object} [params.priorFinalState]
 *        { [staffId]: { lastShift: 'day'|'night'|null, consecutiveWork: number } }
 *        Note: lastShift is stored as a *type* string here; internally we map it
 *        to the department's actual shift code.
 * @returns {{ assignments, warnings, totals }}
 */
export function generateSchedule({ month, department, staff, leaveByStaff, priorFinalState }) {
  const nDays    = daysInMonth(month);
  const dayCode   = department.day_code;
  const nightCode = department.night_code;
  const warnings  = [];

  // state[staffId] = array of nDays codes, 1-indexed (index 0 unused)
  const state = {};
  for (const s of staff) {
    state[s.id] = new Array(nDays + 1).fill(null);
    for (let d = 1; d <= nDays; d++) {
      const ds = dateStr(month, d);
      if (leaveByStaff[s.id]?.has(ds)) state[s.id][d] = LEAVE;
    }
  }

  const totals = {};
  for (const s of staff) {
    let leaveCount = 0;
    for (let d = 1; d <= nDays; d++) if (state[s.id][d] === LEAVE) leaveCount++;
    totals[s.id] = { total: 0, night: 0, weekend: 0, leave: leaveCount };
  }

  // BUG FIX: lastWorkInfo now correctly converts the 'day'/'night' type string
  // stored in priorFinalState.lastShift into the actual department shift code
  // so that comparisons against state values work correctly.
  function lastWorkInfo(staffId, day) {
    if (day === 1) {
      const prior = priorFinalState?.[staffId];
      if (!prior) return { prevCode: null, consecutiveWork: 0 };
      // Convert the type string back to an actual code for correct comparison
      let prevCode = null;
      if (prior.lastShift === 'night') prevCode = nightCode;
      else if (prior.lastShift === 'day') prevCode = dayCode;
      return { prevCode, consecutiveWork: prior.consecutiveWork ?? 0 };
    }
    const prevCode = state[staffId][day - 1];
    let consecutiveWork = 0;
    for (let d = day - 1; d >= 1; d--) {
      const c = state[staffId][d];
      if (c === dayCode || c === nightCode) consecutiveWork++;
      else break;
    }
    return { prevCode, consecutiveWork };
  }

  // night_rest_rule: 1 = enforced (ISOC), 0 = relaxed (SCE - 5 staff makes it mathematically
  // necessary to allow consecutive night→day in some configurations)
  const nightRestRule = (department.night_rest_rule ?? 1) === 1;

  function canAssign(staffId, day, shiftCode) {
    const existing = state[staffId][day];
    if (existing === LEAVE) return false;
    if (existing !== null)  return false;

    const { prevCode, consecutiveWork } = lastWorkInfo(staffId, day);

    // Rule: no Night → Day (configurable per department)
    if (nightRestRule && shiftCode === dayCode && prevCode === nightCode) return false;

    // Rule: max 5 consecutive working days
    if (consecutiveWork >= 5) return false;

    return true;
  }

  function fairnessScore(staffId, shiftCode, day) {
    const t = totals[staffId];
    const weekendPenalty = isWeekend(month, day) ? t.weekend * 0.5 : 0;
    const nightPenalty   = shiftCode === nightCode ? t.night * 2 : 0;
    const leaveAdjusted  = t.total - t.leave * 0.15;
    return leaveAdjusted + nightPenalty + weekendPenalty;
  }

  // Main pass: night first (harder constraint), then day
  for (let day = 1; day <= nDays; day++) {
    for (const shiftCode of [nightCode, dayCode]) {
      const isNight = shiftCode === nightCode;
      const min = isNight ? department.night_min : department.day_min;

      const candidates = staff
        .filter(s => canAssign(s.id, day, shiftCode))
        .sort((a, b) => fairnessScore(a.id, shiftCode, day) - fairnessScore(b.id, shiftCode, day));

      if (candidates.length < min) {
        warnings.push(
          `${department.id} ${dateStr(month, day)}: only ${candidates.length}/${min} available for ${shiftCode} (leave/rest constraints)`
        );
      }

      const max = isNight ? (department.night_max ?? min) : (department.day_max ?? min);
      const needed = Math.min(max, candidates.length);
      for (let i = 0; i < needed; i++) {
        const s = candidates[i];
        state[s.id][day] = shiftCode;
        totals[s.id].total++;
        if (isNight) totals[s.id].night++;
        if (isWeekend(month, day)) totals[s.id].weekend++;
      }
    }

    // Remaining unassigned → Off
    for (const s of staff) {
      if (state[s.id][day] === null) state[s.id][day] = OFF;
    }
  }

  // Local-search improvement pass
  improveBalance({ state, staff, totals, month, nDays, department, dayCode, nightCode });

  const assignments = {};
  for (const s of staff) {
    assignments[s.id] = {};
    for (let d = 1; d <= nDays; d++) {
      assignments[s.id][dateStr(month, d)] = state[s.id][d];
    }
  }

  return { assignments, warnings, totals };
}

function variance(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
}

function improveBalance({ state, staff, totals, month, nDays, department, dayCode, nightCode }) {
  const ITERATIONS = 600;
  const ids = staff.map(s => s.id);

  function constraintsOk(staffId, day) {
    const lo = Math.max(1, day - 5);
    const hi = Math.min(nDays, day + 1);
    for (let d = lo; d <= hi; d++) {
      const code = state[staffId][d];
      if (code === LEAVE) continue;
      if (code === dayCode && state[staffId][d - 1] === nightCode) return false;
      if (code === dayCode || code === nightCode) {
        let run = 0;
        for (let dd = d; dd >= 1 && (state[staffId][dd] === dayCode || state[staffId][dd] === nightCode); dd--) run++;
        if (run > 5) return false;
      }
    }
    return true;
  }

  function coverageOk(day, code, removeId, addId) {
    let count = 0;
    for (const id of ids) {
      let c = state[id][day];
      if (id === removeId) c = OFF;
      if (id === addId) c = code;
      if (c === code) count++;
    }
    const min = code === dayCode ? department.day_min : department.night_min;
    return count >= min;
  }

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const totalVar = variance(ids.map(id => totals[id].total));
    const nightVar = variance(ids.map(id => totals[id].night));
    const weekendVar = variance(ids.map(id => totals[id].weekend));
    const baseVar = totalVar + nightVar * 1.5 + weekendVar * 0.5;
    if (baseVar < 0.01) break;

    const day = 1 + Math.floor(Math.random() * nDays);

    // FIX: sort by composite score rather than just total, so improvement
    // also equalises nights and weekends, not just total shifts.
    const scored = ids.map(id => ({
      id,
      score: totals[id].total + totals[id].night * 0.5 + totals[id].weekend * 0.25,
    })).sort((a, b) => b.score - a.score);

    const busy = scored[0].id;
    const free = scored[scored.length - 1].id;
    if (busy === free) continue;

    const busyCode = state[busy][day];
    const freeCode = state[free][day];

    if ((busyCode !== dayCode && busyCode !== nightCode) || freeCode !== OFF) continue;

    // Attempt swap
    state[busy][day] = OFF;
    state[free][day] = busyCode;

    if (!constraintsOk(busy, day) || !constraintsOk(free, day) || !coverageOk(day, busyCode, busy, free)) {
      state[busy][day] = busyCode;
      state[free][day] = freeCode;
      continue;
    }

    // Update totals tentatively
    totals[busy].total--;
    totals[free].total++;
    const isNight = busyCode === nightCode;
    const isWknd  = isWeekend(month, day);
    if (isNight)  { totals[busy].night--;  totals[free].night++; }
    if (isWknd)   { totals[busy].weekend--; totals[free].weekend++; }

    const newVar = variance(ids.map(id => totals[id].total))
                 + variance(ids.map(id => totals[id].night)) * 1.5
                 + variance(ids.map(id => totals[id].weekend)) * 0.5;

    if (newVar >= baseVar) {
      // Revert
      state[busy][day]  = busyCode;
      state[free][day]  = freeCode;
      totals[busy].total++;
      totals[free].total--;
      if (isNight)  { totals[busy].night++;  totals[free].night--; }
      if (isWknd)   { totals[busy].weekend++; totals[free].weekend--; }
    }
  }
}
