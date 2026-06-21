-- ROC Shift Scheduler — Production D1 Schema
-- Matches roc-mockup.html staff IDs and structure exactly.

CREATE TABLE staff (
  id          TEXT PRIMARY KEY,         -- 'ST', 'CH', 'DA', etc. (matches frontend STAFF ids)
  name        TEXT NOT NULL,
  dept        TEXT NOT NULL,            -- 'ISOC' | 'SCE'
  role        TEXT NOT NULL DEFAULT 'Staff',  -- 'Staff' | 'Admin'
  pin_hash    TEXT,                      -- SHA-256 hex digest of PIN; NULL = PIN not yet set
  color       TEXT NOT NULL DEFAULT '#2D5BE3,#5A3DE8',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,         -- random 32-byte hex
  staff_id    TEXT NOT NULL REFERENCES staff(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_staff ON sessions(staff_id);

CREATE TABLE schedules (
  staff_id    TEXT NOT NULL REFERENCES staff(id),
  year        INTEGER NOT NULL,
  month       INTEGER NOT NULL,         -- 0-indexed, matches JS Date convention
  day         INTEGER NOT NULL,
  code        TEXT NOT NULL,            -- 'D' | 'N' | 'DC' | 'NC' | 'O' | 'L'
  covering    INTEGER NOT NULL DEFAULT 0,  -- 1 if cross-department covering that day
  PRIMARY KEY (staff_id, year, month, day)
);
CREATE INDEX idx_schedules_month ON schedules(year, month);

CREATE TABLE leave_requests (
  id            TEXT PRIMARY KEY,        -- random id
  staff_id      TEXT NOT NULL REFERENCES staff(id),
  date_from     TEXT NOT NULL,           -- YYYY-MM-DD
  date_to       TEXT NOT NULL,           -- YYYY-MM-DD (inclusive)
  days          INTEGER NOT NULL,        -- inclusive day count, computed client-side at submit time
  leave_type    TEXT NOT NULL DEFAULT 'Annual Leave',
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
  reviewed_by   TEXT REFERENCES staff(id),
  requested_at  TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at   TEXT
);
CREATE INDEX idx_leave_status ON leave_requests(status);
CREATE INDEX idx_leave_staff ON leave_requests(staff_id);

CREATE TABLE swap_requests (
  id            TEXT PRIMARY KEY,
  staff_a       TEXT NOT NULL REFERENCES staff(id),  -- requester
  staff_b       TEXT NOT NULL REFERENCES staff(id),  -- counterpart
  date_a        TEXT NOT NULL,           -- YYYY-MM-DD (staff_a's original day)
  shift_a       TEXT NOT NULL,           -- 'D'|'N'|'DC'|'NC'|'O' (staff_a's original shift that day)
  date_b        TEXT NOT NULL,           -- YYYY-MM-DD (staff_b's original day)
  shift_b       TEXT NOT NULL,           -- staff_b's original shift that day
  b_agreed      INTEGER NOT NULL DEFAULT 0,  -- 1 once staff_b accepts
  status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
  requested_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT
);
CREATE INDEX idx_swap_status ON swap_requests(status);

-- ── Seed data: exact match to current frontend STAFF array ──────────────────
INSERT INTO staff (id, name, dept, role, color) VALUES
  ('ST','Stephen','ISOC','Staff','#2D5BE3,#5A3DE8'),
  ('CH','Charles','ISOC','Admin','#7B3FE4,#6366F1'),
  ('DA','Daisy',  'ISOC','Staff','#0A8A5E,#0891B2'),
  ('TA','Tabitha','ISOC','Staff','#C22828,#7C3AED'),
  ('EU','Eugene', 'ISOC','Staff','#1A6BD1,#0E9FD8'),
  ('WA','Wayne',  'ISOC','Staff','#059669,#6366F1'),
  ('BE','Benson', 'ISOC','Staff','#7C3AED,#A855F7'),
  ('OS','Osewe',  'ISOC','Staff','#0891B2,#3D7BFF'),
  ('HI','Hilda',  'ISOC','Staff','#D97706,#EF4444'),
  ('JO','Joan',   'ISOC','Staff','#BE185D,#9333EA'),
  ('MU','Murad',  'SCE', 'Admin','#C22828,#D97706'),
  ('DV','David',  'SCE', 'Staff','#059669,#0891B2'),
  ('GR','Griffin','SCE', 'Admin','#0891B2,#6366F1'),
  ('CB','Chebet', 'SCE', 'Staff','#D97706,#EF4444'),
  ('MO','Moreen', 'SCE', 'Staff','#7C3AED,#BE185D'),
  ('PA','Patrick','SCE', 'Staff','#065F46,#0891B2');

-- NOTE: pin_hash is left NULL for everyone. Each staff member sets their own PIN
-- on first login via the PIN-setup screen (already built into the frontend).
-- This avoids ever storing or transmitting a default/shared plaintext PIN.
