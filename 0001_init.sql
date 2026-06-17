-- ROC Shift Scheduler schema

CREATE TABLE departments (
  id TEXT PRIMARY KEY,        -- 'SCE' | 'ISOC'
  name TEXT NOT NULL,
  day_min INTEGER NOT NULL,   -- min staff required on day shift
  day_max INTEGER NOT NULL,   -- max staff allowed on day shift
  night_min INTEGER NOT NULL, -- min staff required on night shift
  night_max INTEGER NOT NULL, -- max staff allowed on night shift
  day_code TEXT NOT NULL,     -- shift code used for "day" in this dept ('D' or 'DC')
  night_code TEXT NOT NULL    -- shift code used for "night" in this dept ('N' or 'NC')
);

CREATE TABLE staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department_id TEXT NOT NULL REFERENCES departments(id),
  active INTEGER NOT NULL DEFAULT 1
);

-- Locked leave requests: fixed inputs the solver must respect
CREATE TABLE leave_requests (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  date TEXT NOT NULL,         -- YYYY-MM-DD
  status TEXT NOT NULL DEFAULT 'approved' -- 'approved' | 'pending'
);

CREATE UNIQUE INDEX idx_leave_staff_date ON leave_requests(staff_id, date);

-- One row per generated month/version, so schedules can be versioned & compared
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,        -- YYYY-MM
  generated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'published'
  notes TEXT
);

-- Shift assignments: the actual generated/edited schedule
CREATE TABLE shift_assignments (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  staff_id TEXT NOT NULL REFERENCES staff(id),
  date TEXT NOT NULL,         -- YYYY-MM-DD
  shift_code TEXT NOT NULL,   -- 'D' | 'N' | 'DC' | 'NC' | 'O' | 'L'
  is_manual_override INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_assign_unique ON shift_assignments(schedule_id, staff_id, date);
CREATE INDEX idx_assign_schedule ON shift_assignments(schedule_id);
CREATE INDEX idx_assign_staff ON shift_assignments(staff_id);

-- Seed departments based on uploaded June 2026 roster
-- ISOC: exactly 3 on day and 3 on night
-- SCE:  exactly 2 on day, 1–2 on night (min 1, max 2)
INSERT INTO departments (id, name, day_min, day_max, night_min, night_max, day_code, night_code) VALUES
  ('ISOC', 'ISOC',         3, 3, 3, 3, 'D',  'N'),
  ('SCE',  'SCE/SCM Desk', 2, 2, 1, 1, 'DC', 'NC');

-- Seed staff from uploaded roster
INSERT INTO staff (id, name, department_id) VALUES
  ('stephen', 'Stephen', 'ISOC'),
  ('charles', 'Charles', 'ISOC'),
  ('daisy', 'Daisy', 'ISOC'),
  ('tabitha', 'Tabitha', 'ISOC'),
  ('eugene', 'Eugene', 'ISOC'),
  ('wayne', 'Wayne', 'ISOC'),
  ('benson', 'Benson', 'ISOC'),
  ('osewe', 'Osewe', 'ISOC'),
  ('hilda', 'Hilda', 'ISOC'),
  ('joan', 'Joan', 'ISOC'),
  ('murad', 'Murad', 'SCE'),
  ('david', 'David', 'SCE'),
  ('griffin', 'Griffin', 'SCE'),
  ('chebet', 'Chebet', 'SCE'),
  ('moreen', 'Moreen', 'SCE');

-- Patrick added to SCE
INSERT INTO staff (id,name,department_id,active,role,pin_set) VALUES ('patrick','Patrick','SCE',1,'staff',0);
