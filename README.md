# ROC Shift Scheduler — Production Build

Serverless schedule generator for **ISOC** and **SCE/SCM Desk**, built on
Cloudflare Workers + D1.

---

## What's new (production build)

### Bug fixes

| # | Description |
|---|-------------|
| 1 | **Solver: month-boundary rest rule broken** — `canAssign()` compared shift *type strings* (`'night'`) against actual shift *codes* (`'N'`, `'NC'`), so the Night→Day rest rule was never enforced across month boundaries. Fixed in `src/solver.js`. |
| 2 | **Wrong schedule loaded on dept switch** — `GET /api/schedules` had no department filter, so switching from ISOC to SCE returned the most-recently-generated schedule regardless of department. Fixed: `?department=` query param now honoured. |
| 3 | **Coverage warning banner never showed** — the frontend checked `notes.includes('warning')` on a string that starts with `"Warnings:"` — case mismatch. Fixed to parse properly. |
| 4 | **Grid cell click reloaded entire schedule** — caused full re-render and scroll-jump on every cell edit. Fixed: optimistic UI update + background data sync, no re-render. |
| 5 | **`/api/schedules/:id/mine` 500 on missing schedule** — now returns 404 cleanly. |
| 6 | **Assignment patch didn't verify row exists** — now returns 404 if the assignment isn't found. |
| 7 | **`exportBtn` could be clicked with no schedule** — now guarded with a toast. |
| 8 | **Stack traces leaked to clients in production** — `src/index.js` now only exposes `stack` when `env.ENVIRONMENT === 'development'`. |
| 9 | **`alert()` used throughout** — replaced with a non-blocking toast notification system. |
| 10 | **Non-admins couldn't see their own leave** — `GET /api/leave` now allows staff to fetch their own leave without admin role. |

### New features

| Feature | Where |
|---------|-------|
| **PIN reset (admin)** | Admin → Staff Manager → Reset PIN. Clears `pin_set` flag + invalidates sessions. New API: `POST /api/auth/reset-pin` |
| **Staff Manager UI** | Add staff, change roles (admin↔staff), deactivate accounts. New APIs: `PATCH /api/staff/:id`, `DELETE /api/staff/:id` |
| **Shift swap requests** | Staff can request a shift swap with a colleague; admins approve or reject. New table: `swap_requests`. New APIs: `GET/POST /api/swap-requests`, `PATCH/DELETE /api/swap-requests/:id` |
| **"My Leave" tab** | Staff can see their own leave for the selected month without needing admin access. |
| **Coverage summary row** | A compact day-by-day coverage count bar above the grid, colour-coded green/red against minimums. |
| **My schedule filter** | "All days / Working only / Days off" chips on the My Schedule tab. |
| **Toast system** | Replaces all `alert()` calls with non-blocking bottom-right toasts. |
| **Loading overlay** | Full-screen spinner with status text during generate/load operations. |
| **Keyboard shortcuts** | `Esc` closes modals; `Alt+1–6` switches tabs. |
| **Sidebar navigation** | Permanent left sidebar with role-gated sections (My Workspace vs Admin). |
| **Optimistic cell edits** | Grid cells update instantly on click; rollback on API failure. |
| **Health endpoint** | `GET /api/health` — useful for uptime monitoring. |
| **`department_id` on schedules** | Migration `0003_prod.sql` adds this column so dept-filtered queries work. |
| **Role-based department lock** | Staff are locked to their own department; admins can switch freely. |

---

## Setup

### 1. Install Wrangler

```
npm install -g wrangler
wrangler login
```

### 2. Create D1 database

```
wrangler d1 create roc-scheduler-db
```

Copy the `database_id` into `wrangler.toml`.

### 3. Run all migrations

```bash
# --- Local dev ---
wrangler d1 execute roc-scheduler-db --local --file=./migrations/0001_init.sql
wrangler d1 execute roc-scheduler-db --local --file=./migrations/0002_auth.sql
wrangler d1 execute roc-scheduler-db --local --file=./migrations/0003_prod.sql

# --- Production ---
wrangler d1 execute roc-scheduler-db --remote --file=./migrations/0001_init.sql
wrangler d1 execute roc-scheduler-db --remote --file=./migrations/0002_auth.sql
wrangler d1 execute roc-scheduler-db --remote --file=./migrations/0003_prod.sql
```

> **Upgrading from the original build?** Run only `0003_prod.sql` — it's safe to
> run on a database that already has tables from `0001` and `0002`.

### 4. Dev

```
wrangler dev
```

### 5. Deploy

```
wrangler deploy
```

---

## Admin workflow

1. Pick **Department** and **Month** from the controls bar.
2. In **Leave Manager**, add any locked leave days before generating.
3. Click **Generate** → the solver fills the roster.
4. Review the **Team Grid** — coverage warnings appear in the red banner;
   the coverage row shows day/night headcounts per day.
5. Click any cell to cycle it manually (D → N → O → L). Overridden cells are
   outlined in amber.
6. When satisfied, click **Publish** to lock the schedule as the continuity
   baseline for next month.
7. Use **Export CSV** to download the schedule for printing.

### PIN management

If a staff member forgets their PIN: **Staff Manager → Reset PIN**. This clears
their PIN and signs them out everywhere. They'll set a new PIN on next login.

### Shift swaps

Staff submit swap requests from the **Shift Swaps** tab. Admins see all pending
requests and approve or reject them from the same tab.

---

## API reference

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | none | Health check |
| GET | `/api/auth/people` | none | Staff list for login picker |
| POST | `/api/auth/set-pin` | none | First-time PIN setup |
| POST | `/api/auth/login` | none | Sign in |
| POST | `/api/auth/logout` | session | Sign out |
| GET | `/api/auth/me` | session | Current user |
| POST | `/api/auth/reset-pin` | **admin** | Clear another staff member's PIN |
| GET | `/api/departments` | session | List departments |
| GET | `/api/staff` | session | List staff (optional `?department=`) |
| POST | `/api/staff` | **admin** | Add staff |
| GET | `/api/staff/:id` | session | Single staff record |
| PATCH | `/api/staff/:id` | **admin** | Update name / role |
| DELETE | `/api/staff/:id` | **admin** | Deactivate staff |
| GET | `/api/leave` | session | Leave (staff: own only; admin: all) |
| POST | `/api/leave` | **admin** | Add leave |
| DELETE | `/api/leave/:id` | **admin** | Remove leave |
| GET | `/api/swap-requests` | session | List swap requests |
| POST | `/api/swap-requests` | session | Submit swap request |
| PATCH | `/api/swap-requests/:id` | **admin** | Approve / reject |
| DELETE | `/api/swap-requests/:id` | session | Cancel (own request) |
| POST | `/api/schedules/generate` | **admin** | Generate schedule |
| GET | `/api/schedules` | session | List schedules (`?month=`, `?department=`) |
| GET | `/api/schedules/:id` | session | Schedule + assignments |
| GET | `/api/schedules/:id/mine` | session | My shifts + co-workers |
| PATCH | `/api/schedules/:id/assignment` | **admin** | Manual override |
| POST | `/api/schedules/:id/publish` | **admin** | Publish |
| GET | `/api/schedules/:id/export` | session | Download CSV |
