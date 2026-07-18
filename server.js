// Interloop Spares Consumption — API + static server
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

// DB lives at DB_PATH (e.g. /data/inventory.db on a Railway volume).
// First boot with an empty volume: seed it from the bundled database.
const fs0 = require('fs');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'inventory.db');
if (!fs0.existsSync(DB_PATH)) {
  fs0.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs0.copyFileSync(path.join(__dirname, 'inventory.db'), DB_PATH);
  console.log('Seeded database at', DB_PATH);
}
const db = new Database(DB_PATH, { readonly: false });

// ---------- Startup migrations: upgrade whatever schema the volume DB has ----------
function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS targets (
      fy_start INTEGER NOT NULL, hd_code TEXT NOT NULL, target_rate REAL NOT NULL,
      PRIMARY KEY (fy_start, hd_code));
    CREATE TABLE IF NOT EXISTS alerts (
      alert_id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      hd_code TEXT NOT NULL, period_from TEXT NOT NULL, period_to TEXT NOT NULL,
      actual_rate REAL NOT NULL, target_rate REAL NOT NULL,
      message TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS alert_recipients (
      rid INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, hd_code TEXT);
  `);
  // uploads: date-range columns
  const upCols = db.prepare('PRAGMA table_info(uploads)').all().map(c => c.name);
  if (!upCols.includes('date_from')) {
    db.exec('ALTER TABLE uploads ADD COLUMN date_from TEXT; ALTER TABLE uploads ADD COLUMN date_to TEXT');
    db.exec(`UPDATE uploads SET
      date_from=(SELECT MIN(tran_date) FROM transactions t WHERE t.upload_id=uploads.upload_id),
      date_to  =(SELECT MAX(tran_date) FROM transactions t WHERE t.upload_id=uploads.upload_id)`);
    console.log('migrated: uploads -> date ranges');
  }
  // machine_days: month-based -> date-range
  const mdCols = db.prepare('PRAGMA table_info(machine_days)').all().map(c => c.name);
  if (mdCols.length && !mdCols.includes('date_from')) {
    db.exec('DROP VIEW IF EXISTS v_hd_machine_day_cost');
    db.exec(`CREATE TABLE machine_days_new (
      entry_id INTEGER PRIMARY KEY AUTOINCREMENT, hd_code TEXT NOT NULL,
      date_from TEXT NOT NULL, date_to TEXT NOT NULL, machine_days REAL NOT NULL,
      CHECK (date_from <= date_to))`);
    const lastDay = m => new Date(Date.UTC(+m.slice(0,4), +m.slice(5,7), 0)).getUTCDate();
    for (const r of db.prepare('SELECT month_tag, hd_code, machine_days FROM machine_days').all()) {
      db.prepare('INSERT INTO machine_days_new (hd_code, date_from, date_to, machine_days) VALUES (?,?,?,?)')
        .run(r.hd_code, r.month_tag + '-01', r.month_tag + '-' + String(lastDay(r.month_tag)).padStart(2, '0'), r.machine_days);
    }
    db.exec('DROP TABLE machine_days; ALTER TABLE machine_days_new RENAME TO machine_days');
    console.log('migrated: machine_days -> date ranges');
  }
  db.exec('DROP VIEW IF EXISTS v_hd_machine_day_cost');
  db.exec('CREATE INDEX IF NOT EXISTS idx_md_range ON machine_days(hd_code, date_from, date_to)');
}
migrate();

db.pragma('journal_mode = WAL');

const { setupAuth, requireAuth, requireRole } = require('./auth');

const app = express();
app.use(express.json());
setupAuth(app, db);

// Pages: login is public; everything else requires a session
app.get('/', (req, res, next) => req.user ? next() : res.redirect('/login.html'));
app.get('/index.html', (req, res, next) => req.user ? next() : res.redirect('/login.html'));
app.get('/users.html', (req, res) => {
  if (!req.user) return res.redirect('/login.html');
  if (req.user.role !== 'admin') return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'users.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// Plant users are locked to their own division — enforced here, not in the UI.
function scopeToUser(req) {
  const q = { ...req.query };
  if (req.user.role === 'plant' && req.user.hd_code) q.hd = req.user.hd_code;
  return q;
}

// group_by whitelist: UI key -> column in v_consumption
const GROUPS = {
  hd:          { col: 'hd_code',                        label: 'Hosiery Division' },
  unit:        { col: "hd_code || ' ' || unit_code",    label: 'Unit' },
  store:       { col: 'store_name',                     label: 'Store' },
  cost_center: { col: 'cost_center',                    label: 'Cost Center' },
  model:       { col: 'model',                          label: 'Machine Model' },
  machine:     { col: "store_name || ' · ' || short_desc", label: 'Machine' },
  nature:      { col: 'sp_nature',                      label: 'Nature' },
  category:    { col: 'sp_category',                    label: 'Category' },
  maint_type:  { col: 'maint_type',                     label: 'Maint Type' },
  shift:       { col: 'shift',                          label: 'Shift' },
  item:        { col: 'item_code',                      label: 'Item', desc: 'item_description' },
};

// filter whitelist: query param -> column
const FILTERS = {
  hd: 'hd_code', unit: 'unit_code', store: 'store_name', cost_center: 'cost_center',
  model: 'model', machine: 'short_desc', nature: 'sp_nature', category: 'sp_category',
  maint_type: 'maint_type', shift: 'shift',
};

function whereClause(q) {
  const conds = [], params = [];
  if (q.from) { conds.push('tran_date >= ?'); params.push(q.from); }
  if (q.to)   { conds.push('tran_date <= ?'); params.push(q.to); }
  for (const [key, col] of Object.entries(FILTERS)) {
    if (q[key]) {
      const vals = String(q[key]).split('||');           // multi-value: a||b
      conds.push(`${col} IN (${vals.map(() => '?').join(',')})`);
      params.push(...vals);
    }
  }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}


// Pro-rated machine days per HD over an arbitrary date range.
// An entry covering N days contributes machine_days * overlap_days / N.
function machineDaysBetween(from, to) {
  const f = from || '0000-01-01', t = to || '9999-12-31';
  const rows = db.prepare(`SELECT hd_code, date_from, date_to, machine_days
                           FROM machine_days WHERE date_from <= ? AND date_to >= ?`).all(t, f);
  const day = s => Date.UTC(+s.slice(0,4), +s.slice(5,7)-1, +s.slice(8,10)) / 86400000;
  const out = {};
  for (const r of rows) {
    const entDays = day(r.date_to) - day(r.date_from) + 1;
    const ovDays  = Math.min(day(r.date_to), day(t)) - Math.max(day(r.date_from), day(f)) + 1;
    if (ovDays <= 0) continue;
    out[r.hd_code] = (out[r.hd_code] || 0) + r.machine_days * (ovDays / entDays);
  }
  for (const k of Object.keys(out)) out[k] = +out[k].toFixed(2);
  return out;
}

// Dimension values + date bounds for the filter UI
app.get('/api/meta', requireAuth, (req, res) => {
  const one = (sql) => db.prepare(sql).all().map(r => Object.values(r)[0]);
  res.json({
    dates: db.prepare('SELECT MIN(tran_date) AS min, MAX(tran_date) AS max FROM transactions').get(),
    months: one('SELECT DISTINCT month_tag FROM transactions ORDER BY 1'),
    hds: one('SELECT DISTINCT hd_code FROM stores ORDER BY 1'),
    units: one('SELECT DISTINCT unit_code FROM stores ORDER BY 1'),
    stores: one('SELECT store_name FROM stores ORDER BY hd_code, unit_code, knit_code'),
    cost_centers: one('SELECT DISTINCT COALESCE(cc_name, cc_code) FROM cost_centers ORDER BY 1'),
    models: one('SELECT model_display FROM machine_models ORDER BY 1'),
    natures: one('SELECT DISTINCT sp_nature FROM items ORDER BY 1'),
    categories: one('SELECT DISTINCT sp_category FROM items ORDER BY 1'),
    maint_types: one('SELECT DISTINCT maint_type FROM transactions ORDER BY 1'),
    shifts: one('SELECT DISTINCT shift FROM transactions ORDER BY 1'),
    groups: Object.fromEntries(Object.entries(GROUPS).map(([k, v]) => [k, v.label])),
  });
});

// Core: grouped, ranked bleed
app.get('/api/consumption', requireAuth, (req, res) => {
  const q = scopeToUser(req);
  const g = GROUPS[q.group_by || 'hd'];
  if (!g) return res.status(400).json({ error: 'unknown group_by' });
  const { where, params } = whereClause(q);
  const limit = Math.min(parseInt(q.limit || '100', 10), 1000);
  const rows = db.prepare(`
    SELECT ${g.col} AS key,
           ${g.desc ? `MIN(${g.desc}) AS desc,` : ''}
           COUNT(*) AS txns,
           SUM(qty_iss) AS qty,
           ROUND(SUM(value), 2) AS cost
    FROM v_consumption ${where}
    GROUP BY ${g.col}
    ORDER BY cost DESC
    LIMIT ${limit}`).all(...params);
  const total = db.prepare(`SELECT ROUND(SUM(value),2) AS t, COUNT(*) AS n FROM v_consumption ${where}`).get(...params);
  res.json({ group_label: g.label, total_cost: total.t || 0, total_txns: total.n, rows });
});

// KPI: cost per machine day per HD (months intersecting the range)
app.get('/api/kpi', requireAuth, (req, res) => {
  const q = scopeToUser(req);
  const { where, params } = whereClause(q);
  const cost = db.prepare(`
    SELECT hd_code, ROUND(SUM(value),2) AS cost, COUNT(DISTINCT month_tag) AS months
    FROM v_consumption ${where} GROUP BY hd_code`).all(...params);
  const mdMap = machineDaysBetween(q.from, q.to);
  const { fy, targets } = targetsForRange(q.from, q.to);
  res.json({
    period: { from: q.from || null, to: q.to || null },
    fy_label: fy !== null ? fyLabel(fy) : null,
    rows: cost.map(r => {
      const rate = mdMap[r.hd_code] ? +(r.cost / mdMap[r.hd_code]).toFixed(2) : null;
      const tg = targets[r.hd_code];
      return {
        hd: r.hd_code, cost: r.cost, machine_days: mdMap[r.hd_code] || null,
        cost_per_mday: rate, target: tg ?? null,
        vs_target_pct: (rate !== null && tg) ? +((rate / tg - 1) * 100).toFixed(1) : null,
      };
    }).sort((a, b) => a.hd.localeCompare(b.hd)),
  });
});

// ---------- PDF report of the current view ----------
const PDFDocument = require('pdfkit');

app.get('/api/report.pdf', requireAuth, (req, res) => {
  const q = scopeToUser(req);
  const g = GROUPS[q.group_by || 'hd'];
  if (!g) return res.status(400).json({ error: 'unknown group_by' });
  const { where, params } = whereClause(q);
  const limit = Math.min(parseInt(q.limit || '60', 10), 500);

  const rows = db.prepare(`
    SELECT ${g.col} AS key, ${g.desc ? `MIN(${g.desc}) AS desc,` : ''}
           COUNT(*) AS txns, SUM(qty_iss) AS qty, ROUND(SUM(value),2) AS cost
    FROM v_consumption ${where} GROUP BY ${g.col} ORDER BY cost DESC LIMIT ${limit}`).all(...params);
  const total = db.prepare(`SELECT ROUND(SUM(value),2) AS t, COUNT(*) AS n FROM v_consumption ${where}`).get(...params);
  const kpiCost = db.prepare(`
    SELECT hd_code, ROUND(SUM(value),2) AS cost FROM v_consumption ${where} GROUP BY hd_code`).all(...params);
  const mdMap = machineDaysBetween(q.from, q.to);

  const INDIGO = '#23386B', BLEED = '#C22F2F', MUTED = '#69707C', LINE = '#DDE1E7', INK = '#14181F';
  const nfmt = n => n == null ? '—' : Number(n).toLocaleString('en-PK', { maximumFractionDigits: 0 });

  const filtersDesc = Object.entries(FILTERS)
    .filter(([k]) => q[k])
    .map(([k]) => `${GROUPS[k] ? GROUPS[k].label : k}: ${String(q[k]).split('||').join(', ')}`);
  const period = `${q.from || 'start'} to ${q.to || 'end'}`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="spares-bleed-${q.group_by || 'hd'}-${q.from || ''}-${q.to || ''}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margins: { top: 46, bottom: 46, left: 40, right: 40 } });
  doc.pipe(res);
  const W = doc.page.width - 80, X = 40;
  const BOTTOM = doc.page.height - 56;

  // header band
  doc.rect(0, 0, doc.page.width, 64).fill(INDIGO);
  doc.fill('#FFFFFF').font('Helvetica-Bold').fontSize(15).text('SPARES LEDGER', X, 16);
  doc.font('Helvetica').fontSize(8.5).fillColor('#C9D2E6')
     .text('Interloop · Knitting · spare-parts consumption report', X, 36);
  doc.fontSize(8.5).text(`Generated ${new Date().toISOString().slice(0, 10)}`, X, 16, { width: W, align: 'right' });

  let y = 80;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(`Bleed by ${g.label}`, X, y); y += 18;
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`Period: ${period}`, X, y); y += 12;
  if (filtersDesc.length) { doc.text(`Filters: ${filtersDesc.join('  ·  ')}`, X, y); y += 12; }
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10)
     .text(`Total bleed: PKR ${nfmt(total.t)}   ·   ${nfmt(total.n)} issuances`, X, y); y += 20;

  // KPI block: cost per machine day per HD
  if (kpiCost.length) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Cost per machine day (PKR)', X, y); y += 13;
    doc.font('Helvetica').fontSize(8.5);
    const colW = W / Math.max(kpiCost.length, 1);
    kpiCost.sort((a, b) => a.hd_code.localeCompare(b.hd_code)).forEach((r, i) => {
      const rate = mdMap[r.hd_code] ? (r.cost / mdMap[r.hd_code]).toFixed(2) : '—';
      const cx = X + i * colW;
      doc.fillColor(MUTED).text(r.hd_code, cx, y);
      doc.fillColor(BLEED).font('Helvetica-Bold').text(rate, cx, y + 10);
      doc.font('Helvetica').fillColor(MUTED).fontSize(7.5).text(nfmt(r.cost), cx, y + 21).fontSize(8.5);
    });
    y += 36;
    doc.moveTo(X, y).lineTo(X + W, y).strokeColor(LINE).stroke(); y += 10;
  }

  // table header
  const cols = { rank: 22, key: W - 22 - 70 - 55 - 55 - 90, bar: 70, qty: 55, txn: 55, cost: 90 };
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED);
    let cx = X;
    doc.text('#', cx, y, { width: cols.rank }); cx += cols.rank;
    doc.text(g.label.toUpperCase(), cx, y, { width: cols.key }); cx += cols.key;
    doc.text('BLEED', cx, y, { width: cols.bar }); cx += cols.bar;
    doc.text('QTY', cx, y, { width: cols.qty, align: 'right' }); cx += cols.qty;
    doc.text('ISSUES', cx, y, { width: cols.txn, align: 'right' }); cx += cols.txn;
    doc.text('COST (PKR)', cx, y, { width: cols.cost, align: 'right' });
    y += 11; doc.moveTo(X, y).lineTo(X + W, y).strokeColor(LINE).stroke(); y += 4;
  };
  header();
  const maxCost = rows.length ? rows[0].cost : 1;

  const rowH = g.desc ? 21 : 13;
  rows.forEach((r, i) => {
    if (y > BOTTOM - rowH - 2) { doc.addPage(); y = 50; header(); }
    let cx = X;
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(String(i + 1).padStart(2, '0'), cx, y, { width: cols.rank });
    cx += cols.rank;
    if (g.desc) {
      doc.font('Courier').fontSize(7.5).fillColor(INK).text(String(r.key ?? '—').slice(0, 46), cx, y, { width: cols.key, lineBreak: false });
      doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(String(r.desc ?? '').slice(0, 70), cx, y + 9, { width: cols.key, lineBreak: false });
      doc.fontSize(8).fillColor(INK);
    } else {
      doc.fillColor(INK).text(String(r.key ?? '—').slice(0, 60), cx, y, { width: cols.key, lineBreak: false });
    }
    cx += cols.key;
    doc.rect(cx, y + 1, cols.bar - 8, 6).fill('#F7E6E4');
    doc.rect(cx, y + 1, Math.max(1, (cols.bar - 8) * r.cost / maxCost), 6).fill(BLEED);
    cx += cols.bar;
    doc.fillColor(INK).text(nfmt(r.qty), cx, y, { width: cols.qty, align: 'right' }); cx += cols.qty;
    doc.text(nfmt(r.txns), cx, y, { width: cols.txn, align: 'right' }); cx += cols.txn;
    doc.font('Helvetica-Bold').text(`${nfmt(r.cost)}`, cx, y, { width: cols.cost - 26, align: 'right' });
    doc.font('Helvetica').fontSize(6.5).fillColor(MUTED)
       .text(`${(100 * r.cost / (total.t || 1)).toFixed(1)}%`, cx + cols.cost - 24, y + 1, { width: 24, align: 'right' });
    doc.fontSize(8);
    y += rowH;
  });

  doc.font('Helvetica').fontSize(7).fillColor(MUTED)
     .text(`Top ${rows.length} shown. Machine days pro-rated to the period from admin-entered ranges.`,
           X, Math.min(y + 8, BOTTOM), { width: W });
  doc.end();
});


// ---------- Plant-to-plant comparison (admin & full-view only) ----------
app.get('/api/compare', requireAuth, (req, res) => {
  if (req.user.role === 'plant')
    return res.status(403).json({ error: 'Comparison across plants is not available for plant users.' });
  const dim = req.query.dim === 'item' ? 'item' : 'category';
  const col = dim === 'item' ? 'item_code' : 'sp_category';
  const q = { ...req.query };
  const { where, params } = whereClause(q);
  const limit = Math.min(parseInt(q.limit || '30', 10), 200);

  const raw = db.prepare(`
    SELECT ${col} AS key, ${dim === 'item' ? 'MIN(item_description) AS desc,' : ''}
           hd_code, ROUND(SUM(value),2) AS cost, SUM(qty_iss) AS qty
    FROM v_consumption ${where}
    GROUP BY ${col}, hd_code`).all(...params);

  const hds = db.prepare('SELECT DISTINCT hd_code FROM stores ORDER BY hd_code').all().map(r => r.hd_code);
  const mdays = machineDaysBetween(q.from, q.to);

  const byKey = new Map();
  for (const r of raw) {
    if (!byKey.has(r.key)) byKey.set(r.key, { key: r.key, desc: r.desc, per_hd: {}, qty_per_hd: {}, total: 0 });
    const o = byKey.get(r.key);
    o.per_hd[r.hd_code] = r.cost; o.qty_per_hd[r.hd_code] = r.qty; o.total += r.cost;
  }
  const rows = [...byKey.values()].sort((a, b) => b.total - a.total).slice(0, limit)
    .map(r => ({ ...r, total: +r.total.toFixed(2) }));
  res.json({ dim, hds, mdays, rows });
});


// ---------- Admin: monthly data (machine days + file upload) ----------
const multer = require('multer');
const { execFile } = require('child_process');
const fs = require('fs');
const upload = multer({ dest: path.join(__dirname, 'tmp-uploads'),
                        limits: { fileSize: 60 * 1024 * 1024 } });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

app.get('/api/admin/machine-days', requireRole('admin'), (req, res) => {
  const hds = db.prepare('SELECT DISTINCT hd_code FROM stores ORDER BY hd_code').all().map(r => r.hd_code);
  const entries = db.prepare('SELECT entry_id, hd_code, date_from, date_to, machine_days FROM machine_days ORDER BY date_from DESC, hd_code').all();
  res.json({ hds, entries });
});

app.post('/api/admin/machine-days', requireRole('admin'), (req, res) => {
  const { date_from, date_to, values } = req.body || {};
  if (!DATE_RE.test(date_from || '') || !DATE_RE.test(date_to || '') || date_from > date_to)
    return res.status(400).json({ error: 'Provide a valid date range (from ≤ to).' });
  const hds = new Set(db.prepare('SELECT DISTINCT hd_code FROM stores').all().map(r => r.hd_code));
  // reject overlapping entries per HD — overlaps would double-count machine days
  const overlaps = db.prepare(`SELECT hd_code, date_from, date_to FROM machine_days
                               WHERE hd_code = ? AND date_from <= ? AND date_to >= ?`);
  const ins = db.prepare('INSERT INTO machine_days (hd_code, date_from, date_to, machine_days) VALUES (?,?,?,?)');
  const toSave = [];
  for (const [hd, v] of Object.entries(values || {})) {
    if (!hds.has(hd) || v === '' || v === null || v === undefined) continue;
    const num = Number(v);
    if (!isFinite(num) || num < 0) return res.status(400).json({ error: `Invalid machine days for ${hd}.` });
    const ov = overlaps.get(hd, date_to, date_from);
    if (ov) return res.status(400).json({ error:
      `${hd} already has machine days for ${ov.date_from}..${ov.date_to} overlapping this range. Delete that entry first.` });
    toSave.push([hd, num]);
  }
  if (!toSave.length) return res.status(400).json({ error: 'No machine-day values entered.' });
  const tx = db.transaction(() => toSave.forEach(([hd, num]) => ins.run(hd, date_from, date_to, num)));
  tx();
  res.json({ ok: true, saved: toSave.length });
});

app.post('/api/admin/machine-days/:id/delete', requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM machine_days WHERE entry_id=?').run(+req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/uploads', requireRole('admin'), (req, res) => {
  const ups = db.prepare(`SELECT u.upload_id, u.filename, u.month_tag, u.date_from, u.date_to, u.loaded_at, u.row_count, u.total_value,
                                 (SELECT COUNT(*) FROM ingest_issues i WHERE i.upload_id = u.upload_id) AS warnings
                          FROM uploads u ORDER BY u.loaded_at DESC LIMIT 24`).all();
  res.json(ups);
});

app.post('/api/admin/upload', requireRole('admin'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  const orig = req.file.originalname || 'upload.xlsx';
  if (!/\.xlsx$/i.test(orig)) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Please upload the monthly .xlsx transaction file.' }); }
  const tmp = req.file.path + '.xlsx';
  fs.renameSync(req.file.path, tmp);
  const args = [path.join(__dirname, 'ingest.py'), tmp, '--db', DB_PATH];
  const DR = /^\d{4}-\d{2}-\d{2}$/;
  const rf = req.body.date_from, rt = req.body.date_to;
  if (rf || rt) {
    if (!DR.test(rf || '') || !DR.test(rt || '') || rf > rt) {
      fs.unlink(tmp, () => {});
      return res.status(400).json({ error: 'If you set a range, provide valid From and To dates (From ≤ To).' });
    }
    args.push('--range-from', rf, '--range-to', rt);
  }
  execFile('python3', args,
           { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
    fs.unlink(tmp, () => {});
    if (err) {
      const msg = (stdout || '') + (stderr || '');
      return res.status(400).json({ error: 'Ingestion failed.', detail: msg.slice(0, 1200) });
    }
    // record the real filename on the newest upload row
    const last = db.prepare('SELECT upload_id, date_from, date_to FROM uploads ORDER BY upload_id DESC LIMIT 1').get();
    if (last) {
      db.prepare('UPDATE uploads SET filename=? WHERE upload_id=?').run(orig, last.upload_id);
      if (last.date_from && last.date_to) generateAlerts(last.date_from, last.date_to);
    }
    res.json({ ok: true, log: (stdout || '').slice(0, 1200) });
  });
});


// ---------- Admin: purge data for a date range (e.g. an old year) ----------
app.get('/api/admin/purge-preview', requireRole('admin'), (req, res) => {
  const { from, to } = req.query;
  const DR = /^\d{4}-\d{2}-\d{2}$/;
  if (!DR.test(from || '') || !DR.test(to || '') || from > to)
    return res.status(400).json({ error: 'Valid From and To dates required (From ≤ To).' });
  const t = db.prepare(`SELECT COUNT(*) AS n, ROUND(COALESCE(SUM(value),0),2) AS v,
                               MIN(tran_date) AS d1, MAX(tran_date) AS d2
                        FROM transactions WHERE tran_date BETWEEN ? AND ?`).get(from, to);
  const md = db.prepare(`SELECT COUNT(*) AS n FROM machine_days WHERE date_from >= ? AND date_to <= ?`).get(from, to);
  res.json({ transactions: t.n, total_value: t.v, first: t.d1, last: t.d2, machine_day_entries: md.n });
});

app.post('/api/admin/purge', requireRole('admin'), (req, res) => {
  const { from, to, confirm, include_machine_days } = req.body || {};
  const DR = /^\d{4}-\d{2}-\d{2}$/;
  if (!DR.test(from || '') || !DR.test(to || '') || from > to)
    return res.status(400).json({ error: 'Valid From and To dates required (From ≤ To).' });
  if (confirm !== 'DELETE')
    return res.status(400).json({ error: 'Type DELETE in the confirmation box to proceed.' });
  const tx = db.transaction(() => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE tran_date BETWEEN ? AND ?').get(from, to).n;
    db.prepare('DELETE FROM transactions WHERE tran_date BETWEEN ? AND ?').run(from, to);
    let mdn = 0;
    if (include_machine_days) {
      mdn = db.prepare('SELECT COUNT(*) AS n FROM machine_days WHERE date_from >= ? AND date_to <= ?').get(from, to).n;
      db.prepare('DELETE FROM machine_days WHERE date_from >= ? AND date_to <= ?').run(from, to);
    }
    db.prepare(`DELETE FROM ingest_issues WHERE upload_id IN
                (SELECT u.upload_id FROM uploads u
                 WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.upload_id=u.upload_id))`).run();
    db.prepare(`DELETE FROM uploads WHERE NOT EXISTS
                (SELECT 1 FROM transactions t WHERE t.upload_id=uploads.upload_id)`).run();
    return { n, mdn };
  });
  const r = tx();
  res.json({ ok: true, deleted_transactions: r.n, deleted_machine_day_entries: r.mdn });
});


// ---------- Fiscal year helpers, targets, alerts, deviation ----------
const fyOf = d => (+d.slice(5, 7) >= 7) ? +d.slice(0, 4) : +d.slice(0, 4) - 1;
const fyLabel = y => `FY ${String(y).slice(2)}-${String(y + 1).slice(2)}`;

function targetsForRange(from, to) {
  if (!from || !to || fyOf(from) !== fyOf(to)) return { fy: null, targets: {} };  // single-FY ranges only
  const fy = fyOf(from);
  const t = Object.fromEntries(db.prepare('SELECT hd_code, target_rate FROM targets WHERE fy_start=?')
                                 .all(fy).map(r => [r.hd_code, r.target_rate]));
  return { fy, targets: t };
}

// Admin: targets CRUD
app.get('/api/admin/targets', requireRole('admin'), (req, res) => {
  const fy = parseInt(req.query.fy, 10);
  if (!fy || fy < 2025) return res.status(400).json({ error: 'fy (start year, e.g. 2025) required.' });
  const hds = db.prepare('SELECT DISTINCT hd_code FROM stores ORDER BY hd_code').all().map(r => r.hd_code);
  const values = Object.fromEntries(db.prepare('SELECT hd_code, target_rate FROM targets WHERE fy_start=?')
                                      .all(fy).map(r => [r.hd_code, r.target_rate]));
  res.json({ fy, label: fyLabel(fy), hds, values });
});
app.post('/api/admin/targets', requireRole('admin'), (req, res) => {
  const { fy, values } = req.body || {};
  const y = parseInt(fy, 10);
  if (!y || y < 2025) return res.status(400).json({ error: 'fy (start year, e.g. 2025) required.' });
  const hds = new Set(db.prepare('SELECT DISTINCT hd_code FROM stores').all().map(r => r.hd_code));
  const up = db.prepare(`INSERT INTO targets (fy_start, hd_code, target_rate) VALUES (?,?,?)
                         ON CONFLICT(fy_start, hd_code) DO UPDATE SET target_rate=excluded.target_rate`);
  let n = 0;
  for (const [hd, v] of Object.entries(values || {})) {
    if (!hds.has(hd) || v === '' || v === null || v === undefined) continue;
    const num = Number(v);
    if (!isFinite(num) || num <= 0) return res.status(400).json({ error: `Invalid target for ${hd}.` });
    up.run(y, hd, num); n++;
  }
  res.json({ ok: true, saved: n });
});

// Alerts (scoped: plant users see their own HD only)
app.get('/api/alerts', requireAuth, (req, res) => {
  const scope = req.user.role === 'plant' && req.user.hd_code ? 'WHERE hd_code = ?' : '';
  const args = scope ? [req.user.hd_code] : [];
  const rows = db.prepare(`SELECT * FROM alerts ${scope} ORDER BY alert_id DESC LIMIT 20`).all(...args);
  const unseen = db.prepare(`SELECT COUNT(*) AS n FROM alerts ${scope ? scope + ' AND' : 'WHERE'} seen=0`).all(...args)[0] || { n: 0 };
  res.json({ unseen: unseen.n, alerts: rows });
});
app.post('/api/alerts/seen', requireAuth, (req, res) => {
  const scope = req.user.role === 'plant' && req.user.hd_code ? 'WHERE hd_code = ?' : '';
  db.prepare(`UPDATE alerts SET seen=1 ${scope}`).run(...(scope ? [req.user.hd_code] : []));
  res.json({ ok: true });
});

// After an upload: compare the uploaded period's rate per HD against its FY target
function generateAlerts(dateFrom, dateTo) {
  const created = [];
  try {
    const { fy, targets } = targetsForRange(dateFrom, dateTo);
    if (fy === null || !Object.keys(targets).length) return;
    const mdays = machineDaysBetween(dateFrom, dateTo);
    const cost = db.prepare(`SELECT s.hd_code AS hd, SUM(t.value) AS cost
                             FROM transactions t JOIN stores s ON s.warehouse_code=t.warehouse_code
                             WHERE t.tran_date BETWEEN ? AND ? GROUP BY s.hd_code`).all(dateFrom, dateTo);
    const ins = db.prepare(`INSERT INTO alerts (hd_code, period_from, period_to, actual_rate, target_rate, message)
                            VALUES (?,?,?,?,?,?)`);
    for (const r of cost) {
      const tg = targets[r.hd]; const md = mdays[r.hd];
      if (!tg || !md) continue;
      const rate = +(r.cost / md).toFixed(2);
      if (rate > tg) {
        const pct = ((rate / tg - 1) * 100).toFixed(1);
        // headline attribution: which category and machine drove the excess in this period
        const expected = tg * md;
        const cats = db.prepare(`SELECT i.sp_category AS k, SUM(t.value) AS v
          FROM transactions t JOIN stores s ON s.warehouse_code=t.warehouse_code
          JOIN items i ON i.item_code=t.item_code
          WHERE s.hd_code=? AND t.tran_date BETWEEN ? AND ? GROUP BY i.sp_category`).all(r.hd, dateFrom, dateTo);
        const total = cats.reduce((a, c) => a + c.v, 0) || 1;
        const top = cats.map(c => ({ k: c.k, ex: c.v - (c.v / total) * expected }))
                        .sort((a, b) => b.ex - a.ex)[0];
        const mach = db.prepare(`SELECT s.store_name || ' · ' || m.short_desc AS k, SUM(t.value) AS v
          FROM transactions t JOIN stores s ON s.warehouse_code=t.warehouse_code
          JOIN machines m ON m.machine_id=t.machine_id
          WHERE s.hd_code=? AND t.tran_date BETWEEN ? AND ? GROUP BY t.machine_id
          ORDER BY v DESC LIMIT 1`).get(r.hd, dateFrom, dateTo);
        const why = top ? ` Biggest excess driver: ${top.k} (+${Math.round(top.ex).toLocaleString()}).` : '';
        const who = mach ? ` Heaviest machine: ${mach.k} (${Math.round(mach.v).toLocaleString()}).` : '';
        const message = `${r.hd}: ${rate} PKR/machine day for ${dateFrom}..${dateTo} — ${pct}% ABOVE the ${fyLabel(fy)} target of ${tg}.${why}${who} See Target analysis for the full breakdown.`;
        ins.run(r.hd, dateFrom, dateTo, rate, tg, message);
        created.push({ hd: r.hd, pct, message });
      }
    }
  } catch (e) { console.error('alert generation failed:', e.message); }
  emailAlerts(created);
}

// Deviation analysis: WHEN did the rate exceed target, and WHAT drove the excess
app.get('/api/deviation', requireAuth, (req, res) => {
  const q = scopeToUser(req);
  const hd = q.hd;
  const { from, to } = q;
  const bucket = ['day', 'week', 'month'].includes(q.bucket) ? q.bucket : 'month';
  if (!hd || !from || !to) return res.status(400).json({ error: 'hd, from and to are required.' });
  const { fy, targets } = targetsForRange(from, to);
  const target = fy !== null ? targets[hd] : undefined;
  if (target === undefined)
    return res.status(400).json({ error: 'No target set for this division/fiscal year (or the range spans two fiscal years).' });

  const bucketExpr = bucket === 'day' ? 'tran_date'
                   : bucket === 'week' ? "strftime('%Y-W%W', tran_date)"
                   : "substr(tran_date,1,7)";
  const rows = db.prepare(`
    SELECT ${bucketExpr} AS b, MIN(tran_date) AS d1, MAX(tran_date) AS d2, SUM(t.value) AS cost
    FROM transactions t JOIN stores s ON s.warehouse_code=t.warehouse_code
    WHERE s.hd_code=? AND t.tran_date BETWEEN ? AND ? GROUP BY ${bucketExpr} ORDER BY b`).all(hd, from, to);

  const buckets = rows.map(r => {
    const md = machineDaysBetween(r.d1, r.d2)[hd] || null;
    const rate = md ? +(r.cost / md).toFixed(2) : null;
    return { bucket: r.b, from: r.d1, to: r.d2, cost: +r.cost.toFixed(2), machine_days: md,
             rate, target, above: rate !== null && rate > target,
             deviation_pct: rate !== null ? +((rate / target - 1) * 100).toFixed(1) : null };
  });

  // Attribution over the above-target buckets: excess vs expected, split by category / machine
  const above = buckets.filter(b => b.above);
  let attribution = null;
  if (above.length) {
    const ranges = above.map(b => [b.from, b.to]);
    const inRange = ranges.map(() => '(t.tran_date BETWEEN ? AND ?)').join(' OR ');
    const rparams = ranges.flat();
    const mdW = above.reduce((a, b) => a + (b.machine_days || 0), 0);
    const actualW = above.reduce((a, b) => a + b.cost, 0);
    const expectedW = target * mdW;
    // baseline shares from the WHOLE selected period for this HD
    const base = db.prepare(`SELECT i.sp_category AS k, SUM(t.value) AS v
      FROM transactions t JOIN stores s ON s.warehouse_code=t.warehouse_code JOIN items i ON i.item_code=t.item_code
      WHERE s.hd_code=? AND t.tran_date BETWEEN ? AND ? GROUP BY i.sp_category`).all(hd, from, to);
    const baseTotal = base.reduce((a, r) => a + r.v, 0) || 1;
    const share = Object.fromEntries(base.map(r => [r.k, r.v / baseTotal]));
    const catW = db.prepare(`SELECT i.sp_category AS k, SUM(t.value) AS v
      FROM transactions t JOIN stores s ON s.warehouse_code=t.warehouse_code JOIN items i ON i.item_code=t.item_code
      WHERE s.hd_code=? AND (${inRange}) GROUP BY i.sp_category`).all(hd, ...rparams);
    const categories = catW.map(r => ({
      category: r.k, actual: +r.v.toFixed(2),
      expected: +((share[r.k] || 0) * expectedW).toFixed(2),
      excess: +(r.v - (share[r.k] || 0) * expectedW).toFixed(2),
    })).sort((a, b) => b.excess - a.excess).slice(0, 10);
    const machines = db.prepare(`SELECT s.store_name || ' · ' || m.short_desc AS k, SUM(t.value) AS v, COUNT(*) AS n
      FROM transactions t JOIN stores s ON s.warehouse_code=t.warehouse_code JOIN machines m ON m.machine_id=t.machine_id
      WHERE s.hd_code=? AND (${inRange}) GROUP BY t.machine_id ORDER BY v DESC LIMIT 10`).all(hd, ...rparams)
      .map(r => ({ machine: r.k, cost: +r.v.toFixed(2), txns: r.n }));
    attribution = {
      windows: above.map(b => b.bucket),
      actual: +actualW.toFixed(2), expected: +expectedW.toFixed(2),
      excess: +(actualW - expectedW).toFixed(2),
      by_category: categories, top_machines: machines,
    };
  }
  res.json({ hd, fy_label: fyLabel(fy), target, bucket, buckets, attribution });
});


// ---------- Email alerts ----------
// Configure in Railway Variables: SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS,
// SMTP_FROM ("Spares Ledger <alerts@yourdomain>"). Unconfigured -> emails are logged, not sent.
const nodemailer = require('nodemailer');
const mailReady = !!process.env.SMTP_HOST;
const mailer = mailReady
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: +(process.env.SMTP_PORT || 587),
      secure: +(process.env.SMTP_PORT || 587) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : nodemailer.createTransport({ jsonTransport: true });   // dry-run mode

function emailAlerts(newAlerts) {
  if (!newAlerts.length) return;
  const recips = db.prepare('SELECT email, hd_code FROM alert_recipients').all();
  if (!recips.length) return;
  const byEmail = new Map();
  for (const r of recips) {
    const mine = newAlerts.filter(a => !r.hd_code || a.hd === r.hd_code);
    if (mine.length) byEmail.set(r.email, mine);
  }
  for (const [email, list] of byEmail) {
    const subject = `⚠ Spares Ledger: ${list.length === 1
      ? list[0].hd + ' above target (' + list[0].pct + '%)'
      : list.length + ' divisions above target'}`;
    const html = `<div style="font-family:sans-serif;max-width:640px">
      <div style="background:#23386B;color:#fff;padding:12px 16px;font-weight:700">SPARES LEDGER — TARGET ALERT</div>
      <div style="padding:14px 16px;border:1px solid #DDE1E7;border-top:none">
        ${list.map(a => `<p style="margin:0 0 12px">${a.message}</p>`).join('')}
        <p style="color:#69707C;font-size:13px">Open the app → Target analysis for the full breakdown.</p>
      </div></div>`;
    mailer.sendMail({ from: process.env.SMTP_FROM || 'Spares Ledger <alerts@localhost>',
                      to: email, subject, html })
      .then(info => { if (!mailReady) console.log('[dry-run email to', email + ']', subject); })
      .catch(err => console.error('email to', email, 'failed:', err.message));
  }
}

// Admin: manage recipients
app.get('/api/admin/recipients', requireRole('admin'), (req, res) => {
  res.json({ mail_configured: mailReady,
             recipients: db.prepare('SELECT * FROM alert_recipients ORDER BY email').all() });
});
app.post('/api/admin/recipients', requireRole('admin'), (req, res) => {
  const { email, hd_code } = req.body || {};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || ''))
    return res.status(400).json({ error: 'Enter a valid email address.' });
  try {
    db.prepare('INSERT INTO alert_recipients (email, hd_code) VALUES (?,?)')
      .run(String(email).trim().toLowerCase(), hd_code || null);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: 'That email is already on the list.' }); }
});
app.post('/api/admin/recipients/:id/delete', requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM alert_recipients WHERE rid=?').run(+req.params.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Spares dashboard on http://localhost:${PORT}`));
