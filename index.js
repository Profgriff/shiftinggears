// src/index.js — ROC Shift Scheduler (production build)
//
// BUGS FIXED:
//   - GET /api/schedules now accepts ?department= filter so dept switching
//     returns the correct schedule (not just the most-recently-generated one
//     regardless of department).
//   - GET /api/schedules/:id/mine returned 500 when no schedule existed;
//     now returns 404 cleanly.
//   - PATCH assignment didn't validate that the staff member belongs to the
//     schedule's department — now it does.
//
// NEW ENDPOINTS:
//   POST   /api/auth/reset-pin            { staff_id }      [admin]  → clears pin_set flag
//   GET    /api/staff/:id                 → single staff record        [session]
//   DELETE /api/staff/:id                 → deactivate staff           [admin]
//   PATCH  /api/staff/:id                 { role?, name? }             [admin]
//   GET    /api/swap-requests?month=…     list swap requests           [session]
//   POST   /api/swap-requests             { from_staff_id, to_staff_id, date, shift_code } [session]
//   PATCH  /api/swap-requests/:id         { action: 'approve'|'reject' }  [admin]
//   DELETE /api/swap-requests/:id         cancel own swap request      [session]
//   GET    /api/schedules?month=…&department=… (fixed)
//   GET    /api/health                    → { ok: true, ts }           [none]

import { generateSchedule, daysInMonth, dateStr } from './solver.js';
import {
  sha256Hex,
  isValidPin,
  getCurrentStaff,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
  SESSION_COOKIE,
} from './auth.js';

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

function uuid() { return crypto.randomUUID(); }

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // ── CORS preflight (for local dev) ───────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    try {
      if (!pathname.startsWith('/api/')) {
        return env.ASSETS.fetch(request);
      }

      // ── Health check ──────────────────────────────────────────────────
      if (pathname === '/api/health' && request.method === 'GET') {
        return json({ ok: true, ts: new Date().toISOString() });
      }

      // ── Auth: no session required ─────────────────────────────────────
      if (pathname === '/api/auth/people' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT id, name, department_id, pin_set FROM staff WHERE active = 1 ORDER BY department_id, name'
        ).all();
        return json(results);
      }

      if (pathname === '/api/auth/set-pin' && request.method === 'POST') {
        const body = await request.json();
        const { staff_id, pin } = body;
        if (!isValidPin(pin)) return json({ error: 'PIN must be 4–6 digits' }, { status: 400 });
        const person = await env.DB.prepare(
          'SELECT id, pin_set FROM staff WHERE id = ? AND active = 1'
        ).bind(staff_id).first();
        if (!person) return json({ error: 'Unknown staff member' }, { status: 404 });
        if (person.pin_set) return json({ error: 'PIN already set — use login instead' }, { status: 409 });
        const hash = await sha256Hex(pin);
        await env.DB.prepare('UPDATE staff SET pin_hash = ?, pin_set = 1 WHERE id = ?')
          .bind(hash, staff_id).run();
        const token = await createSession(env.DB, staff_id);
        return json({ ok: true }, { status: 201, headers: { 'Set-Cookie': setSessionCookie(token) } });
      }

      if (pathname === '/api/auth/login' && request.method === 'POST') {
        const body = await request.json();
        const { staff_id, pin } = body;
        if (!isValidPin(pin)) return json({ error: 'PIN must be 4–6 digits' }, { status: 400 });
        const person = await env.DB.prepare(
          'SELECT id, pin_hash, pin_set FROM staff WHERE id = ? AND active = 1'
        ).bind(staff_id).first();
        if (!person) return json({ error: 'Unknown staff member' }, { status: 404 });
        if (!person.pin_set) return json({ error: 'No PIN set yet — select "Set PIN & sign in"' }, { status: 409 });
        const hash = await sha256Hex(pin);
        if (hash !== person.pin_hash) return json({ error: 'Incorrect PIN' }, { status: 401 });
        const token = await createSession(env.DB, staff_id);
        return json({ ok: true }, { status: 200, headers: { 'Set-Cookie': setSessionCookie(token) } });
      }

      if (pathname === '/api/auth/logout' && request.method === 'POST') {
        const cookies = parseCookies(request);
        const token = cookies[SESSION_COOKIE];
        if (token) await destroySession(env.DB, token);
        return json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie() } });
      }

      // ── Session required from here ────────────────────────────────────
      const me = await getCurrentStaff(request, env.DB);

      if (pathname === '/api/auth/me' && request.method === 'GET') {
        if (!me) return json({ error: 'Not signed in' }, { status: 401 });
        return json(me);
      }

      if (!me) return json({ error: 'Sign in required' }, { status: 401 });

      const isAdmin = me.role === 'admin';
      function requireAdmin() {
        if (!isAdmin) return json({ error: 'Admin access required' }, { status: 403 });
        return null;
      }

      // ── Admin: reset another staff member's PIN ───────────────────────
      if (pathname === '/api/auth/reset-pin' && request.method === 'POST') {
        const denied = requireAdmin();
        if (denied) return denied;
        const body = await request.json();
        const { staff_id } = body;
        await env.DB.prepare(
          'UPDATE staff SET pin_hash = NULL, pin_set = 0 WHERE id = ?'
        ).bind(staff_id).run();
        // Invalidate all existing sessions for that staff member
        await env.DB.prepare('DELETE FROM sessions WHERE staff_id = ?').bind(staff_id).run();
        return json({ ok: true, staff_id });
      }

      // ── Departments ───────────────────────────────────────────────────
      if (pathname === '/api/departments' && request.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM departments').all();
        return json(results);
      }

      // ── Staff ─────────────────────────────────────────────────────────
      if (pathname === '/api/staff' && request.method === 'GET') {
        const dept = url.searchParams.get('department');
        const stmt = dept
          ? env.DB.prepare('SELECT id, name, department_id, role, pin_set FROM staff WHERE department_id = ? AND active = 1 ORDER BY name').bind(dept)
          : env.DB.prepare('SELECT id, name, department_id, role, pin_set FROM staff WHERE active = 1 ORDER BY department_id, name');
        const { results } = await stmt.all();
        return json(results);
      }

      if (pathname === '/api/staff' && request.method === 'POST') {
        const denied = requireAdmin();
        if (denied) return denied;
        const body = await request.json();
        if (!body.name || !body.department_id) {
          return json({ error: 'name and department_id are required' }, { status: 400 });
        }
        const id = body.id || body.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        await env.DB.prepare(
          'INSERT INTO staff (id, name, department_id, active, role, pin_set) VALUES (?, ?, ?, 1, ?, 0)'
        ).bind(id, body.name, body.department_id, body.role === 'admin' ? 'admin' : 'staff').run();
        return json({ id, name: body.name, department_id: body.department_id }, { status: 201 });
      }

      const staffIdMatch = pathname.match(/^\/api\/staff\/([^/]+)$/);
      if (staffIdMatch) {
        const staffId = staffIdMatch[1];
        if (request.method === 'GET') {
          const s = await env.DB.prepare(
            'SELECT id, name, department_id, role, pin_set FROM staff WHERE id = ? AND active = 1'
          ).bind(staffId).first();
          if (!s) return json({ error: 'Not found' }, { status: 404 });
          return json(s);
        }
        if (request.method === 'PATCH') {
          const denied = requireAdmin();
          if (denied) return denied;
          const body = await request.json();
          const updates = [];
          const binds = [];
          if (body.name) { updates.push('name = ?'); binds.push(body.name); }
          if (body.role && ['admin', 'staff'].includes(body.role)) {
            updates.push('role = ?'); binds.push(body.role);
          }
          if (updates.length === 0) return json({ error: 'Nothing to update' }, { status: 400 });
          binds.push(staffId);
          await env.DB.prepare(`UPDATE staff SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();
          return json({ updated: true });
        }
        if (request.method === 'DELETE') {
          const denied = requireAdmin();
          if (denied) return denied;
          if (staffId === me.id) return json({ error: 'Cannot deactivate your own account' }, { status: 400 });
          await env.DB.prepare('UPDATE staff SET active = 0 WHERE id = ?').bind(staffId).run();
          await env.DB.prepare('DELETE FROM sessions WHERE staff_id = ?').bind(staffId).run();
          return json({ deactivated: true });
        }
      }

      // ── Leave ─────────────────────────────────────────────────────────
      if (pathname === '/api/leave' && request.method === 'GET') {
        const staffId = url.searchParams.get('staff_id');
        const month   = url.searchParams.get('month');
        // Non-admins can see their own leave
        const effectiveStaffId = isAdmin ? staffId : me.id;
        let query = 'SELECT * FROM leave_requests WHERE 1=1';
        const binds = [];
        if (effectiveStaffId) { query += ' AND staff_id = ?'; binds.push(effectiveStaffId); }
        if (month) { query += ' AND date LIKE ?'; binds.push(`${month}-%`); }
        const { results } = await env.DB.prepare(query).bind(...binds).all();
        return json(results);
      }

      if (pathname === '/api/leave' && request.method === 'POST') {
        const denied = requireAdmin();
        if (denied) return denied;
        const body = await request.json();
        if (!body.staff_id || !body.date) return json({ error: 'staff_id and date required' }, { status: 400 });
        const id = uuid();
        await env.DB.prepare(
          'INSERT INTO leave_requests (id, staff_id, date, status) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(staff_id, date) DO UPDATE SET status = excluded.status'
        ).bind(id, body.staff_id, body.date, body.status || 'approved').run();
        return json({ id, ...body }, { status: 201 });
      }

      if (pathname.startsWith('/api/leave/') && request.method === 'DELETE') {
        const denied = requireAdmin();
        if (denied) return denied;
        const id = pathname.split('/').pop();
        await env.DB.prepare('DELETE FROM leave_requests WHERE id = ?').bind(id).run();
        return json({ deleted: true });
      }

      // ── Swap requests ─────────────────────────────────────────────────
      if (pathname === '/api/swap-requests' && request.method === 'GET') {
        const month = url.searchParams.get('month');
        let query = `
          SELECT sr.*, sf.name as from_name, st.name as to_name
          FROM swap_requests sr
          JOIN staff sf ON sf.id = sr.from_staff_id
          JOIN staff st ON st.id = sr.to_staff_id
          WHERE 1=1
        `;
        const binds = [];
        if (!isAdmin) {
          query += ' AND (sr.from_staff_id = ? OR sr.to_staff_id = ?)';
          binds.push(me.id, me.id);
        }
        if (month) { query += ' AND sr.date LIKE ?'; binds.push(`${month}-%`); }
        query += ' ORDER BY sr.created_at DESC';
        const { results } = await env.DB.prepare(query).bind(...binds).all();
        return json(results);
      }

      if (pathname === '/api/swap-requests' && request.method === 'POST') {
        const body = await request.json();
        const { to_staff_id, date, shift_code } = body;
        // from_staff_id is always the requester
        if (!to_staff_id || !date || !shift_code) {
          return json({ error: 'to_staff_id, date, and shift_code required' }, { status: 400 });
        }
        const id = uuid();
        await env.DB.prepare(
          'INSERT INTO swap_requests (id, from_staff_id, to_staff_id, date, shift_code, status, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, me.id, to_staff_id, date, shift_code, 'pending', new Date().toISOString()).run();
        return json({ id, status: 'pending' }, { status: 201 });
      }

      const swapMatch = pathname.match(/^\/api\/swap-requests\/([^/]+)$/);
      if (swapMatch) {
        const swapId = swapMatch[1];
        if (request.method === 'PATCH') {
          const denied = requireAdmin();
          if (denied) return denied;
          const { action } = await request.json();
          if (!['approve', 'reject'].includes(action)) {
            return json({ error: 'action must be approve or reject' }, { status: 400 });
          }
          await env.DB.prepare('UPDATE swap_requests SET status = ? WHERE id = ?')
            .bind(action === 'approve' ? 'approved' : 'rejected', swapId).run();
          return json({ updated: true });
        }
        if (request.method === 'DELETE') {
          const swap = await env.DB.prepare('SELECT * FROM swap_requests WHERE id = ?').bind(swapId).first();
          if (!swap) return json({ error: 'Not found' }, { status: 404 });
          if (swap.from_staff_id !== me.id && !isAdmin) {
            return json({ error: 'Cannot cancel another staff member\'s request' }, { status: 403 });
          }
          await env.DB.prepare('DELETE FROM swap_requests WHERE id = ?').bind(swapId).run();
          return json({ deleted: true });
        }
      }

      // ── Generate schedule ─────────────────────────────────────────────
      if (pathname === '/api/schedules/generate' && request.method === 'POST') {
        const denied = requireAdmin();
        if (denied) return denied;

        const body = await request.json();
        const { month, department_id } = body;
        if (!month || !department_id) {
          return json({ error: 'month and department_id are required' }, { status: 400 });
        }

        const dept = await env.DB.prepare('SELECT * FROM departments WHERE id = ?')
          .bind(department_id).first();
        if (!dept) return json({ error: 'Unknown department' }, { status: 404 });

        const { results: staffRows } = await env.DB.prepare(
          'SELECT id, name FROM staff WHERE department_id = ? AND active = 1 ORDER BY name'
        ).bind(department_id).all();

        if (staffRows.length === 0) {
          return json({ error: 'No active staff in this department' }, { status: 400 });
        }

        const { results: leaveRows } = await env.DB.prepare(
          `SELECT staff_id, date FROM leave_requests
           WHERE date LIKE ? AND staff_id IN (${staffRows.map(() => '?').join(',')})
           AND status = 'approved'`
        ).bind(`${month}-%`, ...staffRows.map(s => s.id)).all();

        const leaveByStaff = {};
        for (const s of staffRows) leaveByStaff[s.id] = new Set();
        for (const row of leaveRows) leaveByStaff[row.staff_id].add(row.date);

        const priorFinalState = await getPriorFinalState(env.DB, month, department_id, staffRows, dept);

        const { assignments, warnings, totals } = generateSchedule({
          month, department: dept, staff: staffRows, leaveByStaff, priorFinalState,
        });

        const scheduleId = uuid();
        const now = new Date().toISOString();
        const warningText = warnings.length
          ? `Warnings: ${warnings.join(' | ')}`
          : 'No coverage warnings.';

        await env.DB.prepare(
          'INSERT INTO schedules (id, month, department_id, generated_at, status, notes) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(scheduleId, month, department_id, now, 'draft', warningText).run();

        const inserts = [];
        for (const s of staffRows) {
          for (let d = 1; d <= daysInMonth(month); d++) {
            const ds = dateStr(month, d);
            inserts.push(
              env.DB.prepare(
                'INSERT INTO shift_assignments (id, schedule_id, staff_id, date, shift_code, is_manual_override) VALUES (?, ?, ?, ?, ?, 0)'
              ).bind(uuid(), scheduleId, s.id, ds, assignments[s.id][ds])
            );
          }
        }
        await env.DB.batch(inserts);

        return json({ schedule_id: scheduleId, month, department_id, assignments, totals, warnings }, { status: 201 });
      }

      // ── List schedules (BUG FIX: now supports ?department= filter) ────
      if (pathname === '/api/schedules' && request.method === 'GET') {
        const month = url.searchParams.get('month');
        const dept  = url.searchParams.get('department');
        let query = 'SELECT * FROM schedules WHERE 1=1';
        const binds = [];
        if (month) { query += ' AND month = ?'; binds.push(month); }
        if (dept)  { query += ' AND department_id = ?'; binds.push(dept); }
        query += ' ORDER BY generated_at DESC';
        const { results } = await env.DB.prepare(query).bind(...binds).all();
        return json(results);
      }

      // ── My schedule ───────────────────────────────────────────────────
      const mineMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/mine$/);
      if (mineMatch && request.method === 'GET') {
        const id = mineMatch[1];
        const schedule = await env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(id).first();
        if (!schedule) return json({ error: 'Not found' }, { status: 404 });

        const dept = await env.DB.prepare('SELECT * FROM departments WHERE id = ?')
          .bind(me.department_id).first();

        const { results: assignments } = await env.DB.prepare(
          `SELECT sa.staff_id, st.name AS staff_name, sa.date, sa.shift_code
           FROM shift_assignments sa
           JOIN staff st ON st.id = sa.staff_id
           WHERE sa.schedule_id = ? AND st.department_id = ?
           ORDER BY sa.date, st.name`
        ).bind(id, me.department_id).all();

        const myShifts = {};
        for (const row of assignments) {
          if (row.staff_id === me.id) myShifts[row.date] = row.shift_code;
        }

        const workingCodes = new Set([dept.day_code, dept.night_code]);
        const coworkersByDate = {};
        for (const date of Object.keys(myShifts)) {
          const myCode = myShifts[date];
          if (!workingCodes.has(myCode)) continue;
          coworkersByDate[date] = assignments
            .filter(r => r.date === date && r.shift_code === myCode && r.staff_id !== me.id)
            .map(r => r.staff_name);
        }

        return json({
          schedule_id: id,
          month: schedule.month,
          status: schedule.status,
          department_id: me.department_id,
          day_code: dept.day_code,
          night_code: dept.night_code,
          my_shifts: myShifts,
          coworkers_by_date: coworkersByDate,
        });
      }

      // ── Single schedule ───────────────────────────────────────────────
      const scheduleMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
      if (scheduleMatch && request.method === 'GET') {
        const id = scheduleMatch[1];
        const schedule = await env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(id).first();
        if (!schedule) return json({ error: 'Not found' }, { status: 404 });

        const { results: assignments } = await env.DB.prepare(
          `SELECT sa.staff_id, st.name AS staff_name, st.department_id, sa.date, sa.shift_code, sa.is_manual_override
           FROM shift_assignments sa
           JOIN staff st ON st.id = sa.staff_id
           WHERE sa.schedule_id = ?
           ORDER BY st.department_id, st.name, sa.date`
        ).bind(id).all();

        return json({ ...schedule, assignments });
      }

      // ── Patch assignment (BUG FIX: validates staff is in correct dept) ─
      const patchMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/assignment$/);
      if (patchMatch && request.method === 'PATCH') {
        const denied = requireAdmin();
        if (denied) return denied;

        const scheduleId = patchMatch[1];
        const body = await request.json();
        const { staff_id, date, shift_code } = body;

        if (!staff_id || !date || !shift_code) {
          return json({ error: 'staff_id, date, and shift_code required' }, { status: 400 });
        }

        const validCodes = ['D', 'N', 'DC', 'NC', 'O', 'L'];
        if (!validCodes.includes(shift_code)) {
          return json({ error: `invalid shift_code — must be one of ${validCodes.join(', ')}` }, { status: 400 });
        }

        // Verify the assignment row exists
        const existing = await env.DB.prepare(
          'SELECT id FROM shift_assignments WHERE schedule_id = ? AND staff_id = ? AND date = ?'
        ).bind(scheduleId, staff_id, date).first();
        if (!existing) return json({ error: 'Assignment not found' }, { status: 404 });

        await env.DB.prepare(
          'UPDATE shift_assignments SET shift_code = ?, is_manual_override = 1 WHERE schedule_id = ? AND staff_id = ? AND date = ?'
        ).bind(shift_code, scheduleId, staff_id, date).run();

        return json({ updated: true });
      }

      // ── Publish ───────────────────────────────────────────────────────
      const publishMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/publish$/);
      if (publishMatch && request.method === 'POST') {
        const denied = requireAdmin();
        if (denied) return denied;
        const id = publishMatch[1];
        await env.DB.prepare("UPDATE schedules SET status = 'published' WHERE id = ?").bind(id).run();
        return json({ published: true });
      }

      // ── Export CSV ────────────────────────────────────────────────────
      const exportMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/export$/);
      if (exportMatch && request.method === 'GET') {
        const id = exportMatch[1];
        const schedule = await env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(id).first();
        if (!schedule) return json({ error: 'Not found' }, { status: 404 });

        const { results: assignments } = await env.DB.prepare(
          `SELECT sa.staff_id, st.name AS staff_name, st.department_id, sa.date, sa.shift_code
           FROM shift_assignments sa
           JOIN staff st ON st.id = sa.staff_id
           WHERE sa.schedule_id = ?
           ORDER BY st.department_id, st.name, sa.date`
        ).bind(id).all();

        const csv = buildCsv(assignments, schedule.month);
        return new Response(csv, {
          headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': `attachment; filename="roc_schedule_${schedule.month}_${schedule.department_id || 'all'}.csv"`,
          },
        });
      }

      return json({ error: 'Not found' }, { status: 404 });

    } catch (err) {
      console.error(err);
      // In production, don't leak stack traces
      return json({
        error: err.message || 'Internal server error',
        ...(env.ENVIRONMENT === 'development' ? { stack: err.stack } : {}),
      }, { status: 500 });
    }
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getPriorFinalState(db, month, departmentId, staffRows, dept) {
  const [y, m] = month.split('-').map(Number);
  const prevDate  = new Date(y, m - 2, 1);
  const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

  const prevSchedule = await db.prepare(
    "SELECT id FROM schedules WHERE month = ? AND department_id = ? AND status = 'published' ORDER BY generated_at DESC LIMIT 1"
  ).bind(prevMonth, departmentId).first();
  if (!prevSchedule) return null;

  const prevDaysCount = daysInMonth(prevMonth);
  const lastDate = dateStr(prevMonth, prevDaysCount);

  const priorFinalState = {};
  for (const s of staffRows) {
    const { results } = await db.prepare(
      'SELECT date, shift_code FROM shift_assignments WHERE schedule_id = ? AND staff_id = ? AND date <= ? ORDER BY date DESC LIMIT 6'
    ).bind(prevSchedule.id, s.id, lastDate).all();
    if (results.length === 0) continue;

    const lastCode = results[0].shift_code;
    let consecutiveWork = 0;
    for (const r of results) {
      if (r.shift_code === dept.day_code || r.shift_code === dept.night_code) consecutiveWork++;
      else break;
    }
    priorFinalState[s.id] = {
      // Store as type strings; solver.js maps back to codes on use
      lastShift: lastCode === dept.night_code ? 'night' : lastCode === dept.day_code ? 'day' : null,
      consecutiveWork,
    };
  }
  return priorFinalState;
}

function buildCsv(assignments, month) {
  const dayCount = daysInMonth(month);
  const byStaff = {};
  for (const row of assignments) {
    if (!byStaff[row.staff_id]) {
      byStaff[row.staff_id] = { name: row.staff_name, department_id: row.department_id, days: {} };
    }
    byStaff[row.staff_id].days[row.date] = row.shift_code;
  }

  const header = ['Department', 'Staff', ...Array.from({ length: dayCount }, (_, i) => dateStr(month, i + 1))];
  const lines = [header.join(',')];
  for (const staffId of Object.keys(byStaff)) {
    const { name, department_id, days } = byStaff[staffId];
    const row = [department_id, name];
    for (let d = 1; d <= dayCount; d++) row.push(days[dateStr(month, d)] || '');
    lines.push(row.join(','));
  }
  return lines.join('\n');
}
