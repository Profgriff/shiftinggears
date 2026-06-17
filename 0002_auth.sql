-- 0002_auth.sql
-- Adds PIN-based login, roles, and sessions.

ALTER TABLE staff ADD COLUMN role TEXT NOT NULL DEFAULT 'staff'; -- 'staff' | 'admin'
ALTER TABLE staff ADD COLUMN pin_hash TEXT;                       -- SHA-256 hex of PIN
ALTER TABLE staff ADD COLUMN pin_set INTEGER NOT NULL DEFAULT 0;  -- 0 = must set PIN on first login

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_staff ON sessions(staff_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- Make one person per department an admin/scheduler by default.
-- Adjust as needed: UPDATE staff SET role = 'admin' WHERE id = '...';
UPDATE staff SET role = 'admin' WHERE id IN ('stephen', 'murad');
