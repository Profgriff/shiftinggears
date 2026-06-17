// src/auth.js
//
// Lightweight PIN-based auth for Cloudflare Workers + D1.
//
// Flow:
//  - First login: staff picks themselves from a list, sets a 4-6 digit PIN
//    (pin_set goes 0 -> 1, pin_hash stored as SHA-256 hex).
//  - Subsequent logins: staff picks themselves, enters PIN, server checks
//    hash match.
//  - On success, a session token (random UUID) is created in `sessions`
//    with a 30-day expiry and returned to the client as an HttpOnly cookie.
//  - Every API request (except /api/auth/*) requires a valid session
//    cookie; the resolved staff record (id, name, department_id, role)
//    is attached to the request context.

const SESSION_DAYS = 30;
const SESSION_COOKIE = 'roc_session';

export async function sha256Hex(input) {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function isValidPin(pin) {
  return typeof pin === 'string' && /^\d{4,6}$/.test(pin);
}

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

export function setSessionCookie(token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function createSession(db, staffId) {
  const token = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.prepare(
    'INSERT INTO sessions (token, staff_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(token, staffId, now.toISOString(), expires.toISOString()).run();
  return token;
}

export async function destroySession(db, token) {
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

/**
 * Resolves the current session to a staff record, or null if no/invalid
 * session. Also opportunistically prunes expired sessions on a hit.
 */
export async function getCurrentStaff(request, db) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const row = await db.prepare(
    `SELECT s.id, s.name, s.department_id, s.role, sess.expires_at
     FROM sessions sess
     JOIN staff s ON s.id = sess.staff_id
     WHERE sess.token = ?`
  ).bind(token).first();

  if (!row) return null;

  if (new Date(row.expires_at) < new Date()) {
    await destroySession(db, token);
    return null;
  }

  return { id: row.id, name: row.name, department_id: row.department_id, role: row.role };
}

export { SESSION_COOKIE };
