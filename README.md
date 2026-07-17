# Spares Ledger — Main Dashboard (v1)

Consumption analytics dashboard for Interloop knitting spares.

## Run
    npm install
    node server.js
    # open http://localhost:3000

Works on desktop and phone (responsive). `inventory.db` (with June 2026 loaded)
is included; add future months with `ingest.py` from the database package.

## What it does
- Date-range + filters: Division, Maint type, Shift, Nature, Category, Model
  (active filters shown as removable chips).
- Six HD tiles: cost per machine day (bleed / typed monthly machine days);
  worst division highlighted in red. Tap a tile to drill into that HD.
- Group-by bar: rank bleed by Division, Unit, Store, Cost Center, Model,
  Machine, Nature, Category, Maint Type, Shift, or Item.
- Every row carries a bleed bar (share of the top value) and % of total.
- Drill-down: HD -> stores -> machines -> items a machine consumed.
  Machine drill pins the store, since machine numbers repeat across stores.

## API (for later screens)
- GET /api/meta — dimension values and date bounds
- GET /api/consumption?from&to&group_by&<filters> — ranked bleed
- GET /api/kpi?from&to&<filters> — per-HD cost & cost/machine-day
- GET /api/report.pdf?from&to&group_by&<filters> — the same view as a downloadable A4 PDF (Download PDF button in the UI)

## Deploy notes
- SQLite now; the same schema/queries port to PostgreSQL for cloud deployment.
- Multi-value filters supported by the API (hd=HD-1||HD-2).

## Access control
- Sign-in required for every page and API. Sessions last 12 hours.
- Roles:
  - **admin** — full dashboard + user management (/users.html) + future edit screens
  - **full view (viewer)** — the whole dashboard, read-only
  - **plant** — locked to their own Hosiery Division; enforced on the server
    (any hd parameter they send is overridden), including PDF exports
- First run creates a default account: **admin / ChangeMe123!**
  Sign in, then change it immediately (POST /api/change-password) and create real users.
- Passwords are bcrypt-hashed; nothing is stored in plain text.

## Plant comparison
- New "Plant comparison" view (admin and full-view roles): rows = categories or items
  (with ERP codes), one column per Hosiery Division, shaded within each row so the
  heaviest plant stands out. Toggle between Total PKR and PKR per machine day.
- Respects all active filters and the date range. Not available to plant users
  (blocked in the UI and with 403 on the API).

## Admin page (users.html)
- Upload the monthly transaction .xlsx from the browser (runs ingest.py server-side;
  needs python3 + pandas + openpyxl on the host). Upload history with warnings count.
- Machine-days entry: pick month, six HD fields (pre-filled from saved values), save.
- User management as before. All admin-only, enforced with 403s on the API.

## Column policy
- The loader reads ONLY the 15 approved columns, selected BY HEADER NAME — red
  markings were never part of the logic, so future unformatted files load identically.
- Extra columns are ignored; a file missing an approved column (or with a renamed
  header) is rejected before load with a message naming the missing columns, and
  existing data stays untouched.
