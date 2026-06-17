-- 0003_prod.sql
-- Production enhancements:
--   1. Add department_id column to schedules so we can filter by dept cleanly
--   2. Add swap_requests table for staff shift-swap workflow
--   3. Add ENVIRONMENT variable placeholder

-- Add department_id to schedules (nullable for backward compat with existing rows)
ALTER TABLE schedules ADD COLUMN department_id TEXT REFERENCES departments(id);

-- Swap requests: staff can ask another staff member to swap a shift
CREATE TABLE IF NOT EXISTS swap_requests (
  id           TEXT PRIMARY KEY,
  from_staff_id TEXT NOT NULL REFERENCES staff(id),
  to_staff_id   TEXT NOT NULL REFERENCES staff(id),
  date          TEXT NOT NULL,           -- YYYY-MM-DD
  shift_code    TEXT NOT NULL,           -- the shift the requester wants to give away
  status        TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  notes         TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_swap_from ON swap_requests(from_staff_id);
CREATE INDEX IF NOT EXISTS idx_swap_to   ON swap_requests(to_staff_id);
CREATE INDEX IF NOT EXISTS idx_swap_date ON swap_requests(date);

-- Add per-department config: whether the night→day rest rule applies,
-- and whether the department operates on weekends
ALTER TABLE departments ADD COLUMN night_rest_rule INTEGER NOT NULL DEFAULT 1;  -- 1=enforced, 0=relaxed
ALTER TABLE departments ADD COLUMN weekend_staffed INTEGER NOT NULL DEFAULT 1;   -- 1=runs weekends, 0=weekdays only

-- ROC is 24/7 — both depts are weekend-staffed
-- ISOC enforces night→day rest; SCE relaxes it (5-person team, mathematically required)
UPDATE departments SET night_rest_rule=1, weekend_staffed=1 WHERE id='ISOC';
-- SCE: night_rest_rule=1 enforced (6 staff makes it feasible with the rest rule)
UPDATE departments SET night_rest_rule=1, weekend_staffed=1 WHERE id='SCE';
