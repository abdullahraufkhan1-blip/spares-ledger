# Spares Ledger — Operations & Deployment Guide

Everything you need to run the show, keep it fed monthly, put it on the cloud, and get it onto phones.

---

## 1. First run (for the demo)

    unzip spares-dashboard.zip && cd spares-app
    npm install
    node server.js

Open **http://localhost:3000**. To demo from a phone on the same Wi-Fi, open `http://<your-PC's-IP>:3000`.

First sign-in: **admin / ChangeMe123!**

Do these two things immediately:
1. Change the admin password (until the settings screen exists, run this once while the server is up):

       curl -X POST http://localhost:3000/api/login -H "Content-Type: application/json" -c s.jar -d "{\"username\":\"admin\",\"password\":\"ChangeMe123!\"}"
       curl -X POST http://localhost:3000/api/change-password -H "Content-Type: application/json" -b s.jar -d "{\"current\":\"ChangeMe123!\",\"next\":\"YOUR-NEW-PASSWORD\"}"

2. Open **Users** (top-right) and create real accounts:
   - **Admin** — you and whoever manages data
   - **Full view** — GMs / management who see everything, read-only
   - **Plant** — one per division head, choose their HD; they will only ever see their own plant, even in PDF exports

## 2. Operating the dashboard

- **Date range + filters** at the top; press **Apply**. Active filters appear as chips — click × to remove one.
- **Six HD tiles** = cost per machine day (bleed ÷ typed machine days). The red one is the worst. Tap a tile to jump into that division.
- **Ranking view**: pick any grouping tab (Division, Unit, Store, Cost Center, Model, Machine, Nature, Category, Maint Type, Shift, Item). Rows are ranked by cost with a bleed bar and % share. **Tap a row to drill** — Division → Stores → Machines → the items that machine consumed. The Item grouping shows ERP code + description.
- **Plant comparison view** (admin & full view only): rows = categories or items, one column per HD, shaded per row. Toggle **Total PKR ↔ PKR per machine day** — per-machine-day is the fair comparison.
- **Download PDF** exports exactly the current slice as an A4 report — filters printed on it, paginated, ready to forward.

## 3. Monthly routine (2 minutes, in the browser)

Open **Admin** (top-right, admins only):

1. **Upload monthly transaction file** — choose the month's .xlsx and press *Upload & load*.
   The server validates, normalizes, and loads it; the result line shows rows, total value,
   and warnings. The history table below lists every load. Re-uploading a month **replaces** it —
   totals can never double.
2. **Machine days** — pick a **date range** (a month, a half-month, a week — whatever period
   your figures cover), type the six HD values, *Save machine days*. Existing entries are listed
   below with delete buttons. Overlapping ranges for the same division are refused, so machine
   days can never double-count. The dashboard pro-rates entries to whatever dates you query.

Refresh the dashboard — the new month is live.
NOTE: the upload runs the bundled ingest.py, so the server machine needs
`python3` with `pandas` and `openpyxl` (`pip3 install pandas openpyxl`).
The CLI equivalents (ingest.py / machine-days.js) still work if you prefer a terminal.

Back up by copying one file: `inventory.db` (do it monthly, after ingestion).

## 4. Putting it on the cloud

The app is one Node process plus one SQLite file, so it needs a host with a **persistent disk**.

**Option A — a small VPS (recommended; ~$5–6/month, full control)**
DigitalOcean droplet, AWS Lightsail, or a company server. On Ubuntu:

    # install Node 20+
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
    # copy the spares-app folder up (scp/rsync), then:
    cd spares-app && npm install

    # run it as a service (systemd) — /etc/systemd/system/spares.service:
    [Unit]
    Description=Spares Ledger
    After=network.target
    [Service]
    WorkingDirectory=/home/ubuntu/spares-app
    ExecStart=/usr/bin/node server.js
    Environment=NODE_ENV=production
    Environment=PORT=3000
    Restart=always
    [Install]
    WantedBy=multi-user.target

    sudo systemctl enable --now spares

    # HTTPS + domain with Caddy (2 lines, automatic certificates):
    sudo apt install -y caddy
    # /etc/caddy/Caddyfile:
    spares.yourdomain.com {
        reverse_proxy localhost:3000
    }
    sudo systemctl reload caddy

Point a DNS record (e.g. `spares.` under a domain you own) at the server and you're live at `https://spares.yourdomain.com`. HTTPS is not optional — people type passwords into this. `NODE_ENV=production` switches the session cookies to HTTPS-only.

**Option B — Railway / Render (no server admin)**
Create a project from the folder, add a **persistent volume** mounted where `inventory.db` lives, set `NODE_ENV=production`. Both give you HTTPS automatically. Monthly ingestion then runs via their shell, or wait for the upload screen.

**Not Vercel/Netlify serverless** — their filesystems are throwaway, so the SQLite database would vanish between requests. (When usage grows, the clean upgrade is moving the same schema to PostgreSQL — the queries port almost unchanged.)

**Company-internal alternative:** the same setup on an internal server + IT-issued DNS name works if you'd rather keep the data inside Interloop's network.

## 5. Phones — "downloadable" app

The app is a **PWA** (installable web app). Once the site is on HTTPS:

- **Android (Chrome):** open the site → menu ⋮ → **Add to Home screen / Install app**
- **iPhone (Safari):** open the site → Share → **Add to Home Screen**

It then launches full-screen from its own indigo icon like a native app — no app store, no separate codebase, and every update you deploy reaches everyone instantly. Plant heads install it once and live in their own division's numbers.

## 6. What's still on the roadmap

- Browser **upload screen** (admin drags the monthly xlsx in) and **machine-days form** — replaces the two commands in §3
- **Settings page** for password changes (replaces the curl in §1)
- Cost-center display names (send them anytime — one UPDATE fills them in)
- If plant users should see an anonymized plant comparison, say so
