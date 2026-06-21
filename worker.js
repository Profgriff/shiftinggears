// ROC Shift Scheduler — Cloudflare Worker API
// Talks to D1. All PINs are hashed (SHA-256) before storage/comparison — never stored or
// transmitted in plaintext after the initial setup request (which itself only travels over
// HTTPS, the same as any login form).

const SESSION_TTL_HOURS = 24 * 7; // 7 days

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSessionStaff(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT s.* FROM sessions sess JOIN staff s ON s.id = sess.staff_id
     WHERE sess.token = ? AND sess.expires_at > datetime('now')`
  ).bind(token).first();
  return row || null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      // ── Public: list staff for the login dropdown (id, name, dept only — no PIN status) ──
      if (path === '/api/staff/list' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT id, name, dept, role, color, (pin_hash IS NOT NULL) AS pin_set FROM staff WHERE active = 1 ORDER BY dept, name`
        ).all();
        return json({ staff: results });
      }

      // ── Public: check PIN, log in OR signal "needs setup" ──
      if (path === '/api/auth/login' && request.method === 'POST') {
        const { staffId, pin } = await request.json();
        if (!staffId || !pin || pin.length !== 6) return json({ error: 'Invalid request' }, 400);

        const staff = await env.DB.prepare('SELECT * FROM staff WHERE id = ? AND active = 1').bind(staffId).first();
        if (!staff) return json({ error: 'Staff not found' }, 404);

        if (!staff.pin_hash) {
          return json({ needsSetup: true });
        }

        const hash = await sha256Hex(pin);
        if (hash !== staff.pin_hash) {
          return json({ error: 'Incorrect PIN' }, 401);
        }

        const token = randomToken();
        const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
        await env.DB.prepare('INSERT INTO sessions (token, staff_id, expires_at) VALUES (?, ?, ?)')
          .bind(token, staff.id, expiresAt).run();

        return json({
          token,
          staff: { id: staff.id, name: staff.name, dept: staff.dept, role: staff.role, color: staff.color },
        });
      }

      // ── Public: first-time PIN setup ──
      if (path === '/api/auth/setup-pin' && request.method === 'POST') {
        const { staffId, pin } = await request.json();
        if (!staffId || !pin || pin.length !== 6) return json({ error: 'Invalid request' }, 400);

        const staff = await env.DB.prepare('SELECT * FROM staff WHERE id = ? AND active = 1').bind(staffId).first();
        if (!staff) return json({ error: 'Staff not found' }, 404);
        if (staff.pin_hash) return json({ error: 'PIN already set' }, 409);

        const hash = await sha256Hex(pin);
        await env.DB.prepare('UPDATE staff SET pin_hash = ? WHERE id = ?').bind(hash, staffId).run();

        return json({ ok: true });
      }

      // ── Everything below requires a valid session ──
      const me = await getSessionStaff(request, env);
      if (!me) return json({ error: 'Not authenticated' }, 401);

      if (path === '/api/auth/logout' && request.method === 'POST') {
        const auth = request.headers.get('Authorization') || '';
        const token = auth.slice(7);
        await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
        return json({ ok: true });
      }

      // ── Schedule: fetch a month (generates+caches on first request) ──
      if (path === '/api/schedule' && request.method === 'GET') {
        const year = parseInt(url.searchParams.get('year'), 10);
        const month = parseInt(url.searchParams.get('month'), 10);
        if (isNaN(year) || isNaN(month)) return json({ error: 'year and month required' }, 400);

        const { results } = await env.DB.prepare(
          'SELECT staff_id, day, code, covering FROM schedules WHERE year = ? AND month = ?'
        ).bind(year, month).all();

        return json({ year, month, entries: results });
      }

      // ── Schedule: save a generated month (admin-triggered "Generate") ──
      if (path === '/api/schedule' && request.method === 'POST') {
        if (me.role !== 'Admin') return json({ error: 'Admin only' }, 403);
        const { year, month, entries } = await request.json();
        if (!Array.isArray(entries)) return json({ error: 'entries[] required' }, 400);

        const stmts = [
          env.DB.prepare('DELETE FROM schedules WHERE year = ? AND month = ?').bind(year, month),
          ...entries.map(e =>
            env.DB.prepare('INSERT INTO schedules (staff_id, year, month, day, code, covering) VALUES (?,?,?,?,?,?)')
              .bind(e.staffId, year, month, e.day, e.code, e.covering ? 1 : 0)
          ),
        ];
        await env.DB.batch(stmts);
        return json({ ok: true, count: entries.length });
      }

      // ── Leave requests ──
      if (path === '/api/leave' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT l.*, s.name AS staff_name, s.dept AS staff_dept FROM leave_requests l
           JOIN staff s ON s.id = l.staff_id ORDER BY l.requested_at DESC`
        ).all();
        return json({ requests: results });
      }

      if (path === '/api/leave' && request.method === 'POST') {
        const { dateFrom, dateTo, days, leaveType, reason } = await request.json();
        if (!dateFrom || !dateTo || !days) return json({ error: 'dateFrom, dateTo, days required' }, 400);
        const id = randomToken().slice(0, 16);
        await env.DB.prepare(
          'INSERT INTO leave_requests (id, staff_id, date_from, date_to, days, leave_type, reason) VALUES (?,?,?,?,?,?,?)'
        ).bind(id, me.id, dateFrom, dateTo, days, leaveType || 'Annual Leave', reason || '').run();
        return json({ ok: true, id });
      }

      if (path.match(/^\/api\/leave\/[^/]+\/resolve$/) && request.method === 'POST') {
        if (me.role !== 'Admin') return json({ error: 'Admin only' }, 403);
        const id = path.split('/')[3];
        const { status } = await request.json(); // 'approved' | 'rejected'
        if (!['approved', 'rejected'].includes(status)) return json({ error: 'invalid status' }, 400);
        await env.DB.prepare(
          `UPDATE leave_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`
        ).bind(status, me.id, id).run();
        return json({ ok: true });
      }

      // ── Swap requests ──
      if (path === '/api/swaps' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT sw.*, sa.name AS staff_a_name, sb.name AS staff_b_name
           FROM swap_requests sw
           JOIN staff sa ON sa.id = sw.staff_a JOIN staff sb ON sb.id = sw.staff_b
           ORDER BY sw.requested_at DESC`
        ).all();
        return json({ requests: results });
      }

      if (path === '/api/swaps' && request.method === 'POST') {
        const { staffB, dateA, shiftA, dateB, shiftB } = await request.json();
        if (!staffB || !dateA || !shiftA || !dateB || !shiftB) {
          return json({ error: 'staffB, dateA, shiftA, dateB, shiftB required' }, 400);
        }
        const partner = await env.DB.prepare('SELECT * FROM staff WHERE id = ? AND active = 1').bind(staffB).first();
        if (!partner) return json({ error: 'Staff not found' }, 404);
        if (partner.dept !== me.dept) {
          return json({ error: 'Swaps can only be made within the same department (shift codes differ between departments)' }, 400);
        }
        const id = randomToken().slice(0, 16);
        await env.DB.prepare(
          'INSERT INTO swap_requests (id, staff_a, staff_b, date_a, shift_a, date_b, shift_b) VALUES (?,?,?,?,?,?,?)'
        ).bind(id, me.id, staffB, dateA, shiftA, dateB, shiftB).run();
        return json({ ok: true, id });
      }

      // Counterpart agrees to a pending swap (does not yet apply it — admin still approves)
      if (path.match(/^\/api\/swaps\/[^/]+\/agree$/) && request.method === 'POST') {
        const id = path.split('/')[3];
        const sw = await env.DB.prepare('SELECT * FROM swap_requests WHERE id = ?').bind(id).first();
        if (!sw) return json({ error: 'Swap not found' }, 404);
        if (sw.staff_b !== me.id) return json({ error: 'Only the counterpart can agree to this swap' }, 403);
        await env.DB.prepare('UPDATE swap_requests SET b_agreed = 1 WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }

      if (path.match(/^\/api\/swaps\/[^/]+\/resolve$/) && request.method === 'POST') {
        if (me.role !== 'Admin') return json({ error: 'Admin only' }, 403);
        const id = path.split('/')[3];
        const { status } = await request.json(); // 'approved' | 'rejected'
        if (!['approved', 'rejected'].includes(status)) return json({ error: 'invalid status' }, 400);

        await env.DB.prepare(
          `UPDATE swap_requests SET status = ?, resolved_at = datetime('now') WHERE id = ?`
        ).bind(status, id).run();

        if (status === 'approved') {
          const sw = await env.DB.prepare('SELECT * FROM swap_requests WHERE id = ?').bind(id).first();
          if (sw) {
            const [yA, mA, dA] = sw.date_a.split('-').map(Number);
            const [yB, mB, dB] = sw.date_b.split('-').map(Number);
            await env.DB.batch([
              env.DB.prepare(
                `INSERT INTO schedules (staff_id, year, month, day, code, covering) VALUES (?,?,?,?,?,0)
                 ON CONFLICT(staff_id, year, month, day) DO UPDATE SET code = excluded.code`
              ).bind(sw.staff_a, yA, mA - 1, dA, sw.shift_b),
              env.DB.prepare(
                `INSERT INTO schedules (staff_id, year, month, day, code, covering) VALUES (?,?,?,?,?,0)
                 ON CONFLICT(staff_id, year, month, day) DO UPDATE SET code = excluded.code`
              ).bind(sw.staff_b, yB, mB - 1, dB, sw.shift_a),
            ]);
          }
        }
        return json({ ok: true });
      }

      // ── Admin: force-set or reset a staff member's PIN (e.g. on add/edit, or a reset) ──
      if (path.match(/^\/api\/staff\/[^/]+\/pin$/) && request.method === 'PUT') {
        if (me.role !== 'Admin') return json({ error: 'Admin only' }, 403);
        const id = path.split('/')[3];
        const { pin } = await request.json();
        if (pin) {
          if (pin.length !== 6) return json({ error: 'PIN must be 6 digits' }, 400);
          const hash = await sha256Hex(pin);
          await env.DB.prepare('UPDATE staff SET pin_hash = ? WHERE id = ?').bind(hash, id).run();
        } else {
          // No pin provided -- this is a RESET: clear it so they re-set it on next login.
          await env.DB.prepare('UPDATE staff SET pin_hash = NULL WHERE id = ?').bind(id).run();
        }
        return json({ ok: true });
      }

      // ── Staff management (admin) ──
      if (path === '/api/staff' && request.method === 'POST') {
        if (me.role !== 'Admin') return json({ error: 'Admin only' }, 403);
        const { id, name, dept, role, color } = await request.json();
        if (!id || !name || !dept) return json({ error: 'id, name, dept required' }, 400);
        await env.DB.prepare(
          'INSERT INTO staff (id, name, dept, role, color) VALUES (?,?,?,?,?)'
        ).bind(id, name, dept, role || 'Staff', color || '#2D5BE3,#5A3DE8').run();
        return json({ ok: true });
      }

      if (path.match(/^\/api\/staff\/[^/]+$/) && request.method === 'PUT') {
        if (me.role !== 'Admin') return json({ error: 'Admin only' }, 403);
        const id = path.split('/')[3];
        const { name, dept, role } = await request.json();
        if (!name || !dept) return json({ error: 'name, dept required' }, 400);
        await env.DB.prepare('UPDATE staff SET name = ?, dept = ?, role = ? WHERE id = ?')
          .bind(name, dept, role || 'Staff', id).run();
        return json({ ok: true });
      }

      if (path.match(/^\/api\/staff\/[^/]+$/) && request.method === 'DELETE') {
        if (me.role !== 'Admin') return json({ error: 'Admin only' }, 403);
        const id = path.split('/')[3];
        await env.DB.prepare('UPDATE staff SET active = 0 WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: 'Server error', detail: String(err) }, 500);
    }
  },
};
