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
// Performance: big page cache, memory-mapped reads, in-memory temp tables.
db.pragma('journal_mode = WAL');
db.pragma('cache_size = -65536');      // 64 MB page cache
db.pragma('mmap_size = 268435456');    // 256 MB memory-mapped reads
db.pragma('temp_store = MEMORY');
db.pragma('synchronous = NORMAL');

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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_txn_cover_wh
             ON transactions(tran_date, warehouse_code, qty_iss, value)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_txn_cover_item
             ON transactions(tran_date, item_code, qty_iss, value)`);
  db.exec('ANALYZE');
  db.exec(`CREATE TABLE IF NOT EXISTS downtime (
    dt_id INTEGER PRIMARY KEY AUTOINCREMENT,
    hd_code TEXT NOT NULL,
    date_from TEXT NOT NULL,
    date_to TEXT NOT NULL,
    factor REAL NOT NULL CHECK (factor >= 0 AND factor <= 1),
    note TEXT,
    CHECK (date_from <= date_to))`);
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


// ---------- Lean query builder: join only the tables a query needs ----------
const COLSRC = {  // column -> { table, expr }
  hd_code:      { t: 's', e: 's.hd_code' },
  unit_code:    { t: 's', e: 's.unit_code' },
  store_name:   { t: 's', e: 's.store_name' },
  cost_center:  { t: 'c', e: 'COALESCE(c.cc_name, t.cc_code)' },
  model:        { t: 'mm', e: 'mm.model_display' },
  short_desc:   { t: 'm', e: 'm.short_desc' },
  item_code:    { t: '', e: 't.item_code' },
  item_description: { t: 'i', e: 'i.description' },
  sp_nature:    { t: 'i', e: 'i.sp_nature' },
  sp_category:  { t: 'i', e: 'i.sp_category' },
  maint_type:   { t: '', e: 't.maint_type' },
  shift:        { t: '', e: 't.shift' },
};
const JOINS = {
  s:  'JOIN stores s ON s.warehouse_code = t.warehouse_code',
  i:  'JOIN items i ON i.item_code = t.item_code',
  m:  'JOIN machines m ON m.machine_id = t.machine_id',
  mm: 'JOIN machines m2u ON m2u.machine_id = t.machine_id LEFT JOIN machine_models mm ON mm.model_key = m2u.model_key',
  c:  'LEFT JOIN cost_centers c ON c.cc_code = t.cc_code',
};
function leanQuery(q, groupExprCols) {
  const need = new Set();
  const conds = [], params = [];
  if (q.from) { conds.push('t.tran_date >= ?'); params.push(q.from); }
  if (q.to)   { conds.push('t.tran_date <= ?'); params.push(q.to); }
  for (const [key, col] of Object.entries(FILTERS)) {
    if (!q[key]) continue;
    const src = COLSRC[col];
    if (src && src.t) need.add(src.t);
    const expr = src ? src.e : col;
    const vals = String(q[key]).split('||');
    conds.push(`${expr} IN (${vals.map(() => '?').join(',')})`);
    params.push(...vals);
  }
  for (const c of groupExprCols) {
    const src = COLSRC[c];
    if (src && src.t) need.add(src.t);
  }
  if (need.has('mm') && need.has('m')) need.delete('mm');           // m covers model via join below
  let joins = [...need].map(k => JOINS[k]).join(' ');
  if (need.has('m') && groupExprCols.includes('model'))
    joins += ' LEFT JOIN machine_models mm ON mm.model_key = m.model_key';
  return { joins, where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

// group_by whitelist: UI key -> column in v_consumption
const GROUPS = {
  hd:          { col: 'hd_code',                        srcs: ['hd_code'],               lean: 's.hd_code',                              label: 'Hosiery Division' },
  unit:        { col: "hd_code || ' ' || unit_code",    srcs: ['hd_code','unit_code'],   lean: "s.hd_code || ' ' || s.unit_code",        label: 'Unit' },
  store:       { col: 'store_name',                     srcs: ['store_name'],            lean: 's.store_name',                           label: 'Store', desc: 'warehouse_code', leanDesc: "'Locator ' || MIN(s.warehouse_code)" },
  cost_center: { col: 'cost_center',                    srcs: ['cost_center'],           lean: 'COALESCE(c.cc_name, t.cc_code)',         label: 'Cost Center' },
  model:       { col: 'model',                          srcs: ['model'],                 lean: 'mm.model_display',                        label: 'Machine Model' },
  machine:     { col: "store_name || ' · ' || short_desc", srcs: ['store_name','short_desc'], lean: "s.store_name || ' · ' || m.short_desc", label: 'Machine' },
  nature:      { col: 'sp_nature',                      srcs: ['sp_nature'],             lean: 'i.sp_nature',                            label: 'Nature' },
  category:    { col: 'sp_category',                    srcs: ['sp_category'],           lean: 'i.sp_category',                          label: 'Category' },
  maint_type:  { col: 'maint_type',                     srcs: ['maint_type'],            lean: 't.maint_type',                           label: 'Maint Type' },
  shift:       { col: 'shift',                          srcs: ['shift'],                 lean: 't.shift',                                label: 'Shift' },
  item:        { col: 'item_code',                      srcs: ['item_code'],             lean: 't.item_code',                            label: 'Item', desc: 'item_description', leanDesc: 'MIN(i.description)', descSrc: 'item_description' },
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


// Pro-rated machine days per HD over an arbitrary date range, weighted by
// shutdown/closure entries: closed days carry factor 0, partial days their
// fraction, normal days 1. An entry's TOTAL machine days are redistributed
// across its weighted days — closures shift capacity, never delete it.
const dayNum = s => Date.UTC(+s.slice(0,4), +s.slice(5,7)-1, +s.slice(8,10)) / 86400000;
function machineDaysBetween(from, to) {
  const f = from || '0000-01-01', t = to || '9999-12-31';
  const rows = db.prepare(`SELECT hd_code, date_from, date_to, machine_days
                           FROM machine_days WHERE date_from <= ? AND date_to >= ?`).all(t, f);
  const out = {};
  for (const r of rows) {
    const e1 = dayNum(r.date_from), e2 = dayNum(r.date_to);
    const w1 = Math.max(e1, dayNum(f)), w2 = Math.min(e2, dayNum(t));
    if (w2 < w1) continue;
    const dts = db.prepare(`SELECT date_from, date_to, factor FROM downtime
                            WHERE hd_code = ? AND date_from <= ? AND date_to >= ?`)
                  .all(r.hd_code, r.date_to, r.date_from);
    let contrib;
    if (!dts.length) {
      contrib = r.machine_days * ((w2 - w1 + 1) / (e2 - e1 + 1));
    } else {
      const spans = dts.map(d => ({ a: dayNum(d.date_from), b: dayNum(d.date_to), fct: d.factor }));
      let sumAll = 0, sumWin = 0;
      for (let d = e1; d <= e2; d++) {
        let w = 1;
        for (const sp of spans) if (d >= sp.a && d <= sp.b) w = Math.min(w, sp.fct);
        sumAll += w;
        if (d >= w1 && d <= w2) sumWin += w;
      }
      contrib = sumAll > 0 ? r.machine_days * (sumWin / sumAll) : 0;
    }
    out[r.hd_code] = (out[r.hd_code] || 0) + contrib;
  }
  for (const k of Object.keys(out)) out[k] = +out[k].toFixed(2);
  return out;
}

// Dimension values + date bounds for the filter UI
let META_CACHE = null;
function bustMeta() { META_CACHE = null; }
app.get('/api/meta', requireAuth, (req, res) => {
  if (META_CACHE) return res.json(META_CACHE);
  const one = (sql) => db.prepare(sql).all().map(r => Object.values(r)[0]);
  const payload = {
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
  };
  META_CACHE = payload;
  res.json(payload);
});

// Core: grouped, ranked bleed
app.get('/api/consumption', requireAuth, (req, res) => {
  const q = scopeToUser(req);
  const g = GROUPS[q.group_by || 'hd'];
  if (!g) return res.status(400).json({ error: 'unknown group_by' });
  const limit = Math.min(parseInt(q.limit || '100', 10), 1000);
  const groupCols = [...g.srcs, ...(g.descSrc ? [g.descSrc] : [])];
  const { joins, where, params } = leanQuery(q, groupCols);
  const rows = db.prepare(`
    SELECT ${g.lean} AS key,
           ${g.leanDesc ? `${g.leanDesc} AS desc,` : ''}
           COUNT(*) AS txns,
           SUM(t.qty_iss) AS qty,
           ROUND(SUM(t.value), 2) AS cost
    FROM transactions t ${joins} ${where}
    GROUP BY ${g.lean}
    ORDER BY cost DESC
    LIMIT ${limit}`).all(...params);
  const tq = leanQuery(q, []);
  const total = db.prepare(`SELECT ROUND(SUM(t.value),2) AS t, COUNT(*) AS n
                            FROM transactions t ${tq.joins} ${tq.where}`).get(...tq.params);
  res.json({ group_label: g.label, total_cost: total.t || 0, total_txns: total.n, rows });
});

// KPI: cost per machine day per HD (months intersecting the range)
app.get('/api/kpi', requireAuth, (req, res) => {
  const q = scopeToUser(req);
  const { joins, where, params } = leanQuery(q, ['hd_code']);
  const cost = db.prepare(`
    SELECT s.hd_code, ROUND(SUM(t.value),2) AS cost
    FROM transactions t ${joins} ${where} GROUP BY s.hd_code`).all(...params);
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


// ---------- PDF chart helpers (vector graphics via pdfkit) ----------
const PALETTE = ['#23386B', '#C22F2F', '#4A6FA5', '#E0A458', '#5B8C5A', '#8B5E83', '#69707C', '#A3B4CC', '#B8860B', '#2F6F6F'];
const kfmt = n => {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(0) + 'k';
  return String(Math.round(n));
};

// Vertical bar chart. data: [{label, value}], opts: {color, targetLine, valueFmt}
function pdfBarChart(doc, x, y, w, h, data, opts = {}) {
  const vf = opts.valueFmt || kfmt;
  const max = Math.max(...data.map(d => d.value), opts.targetLine || 0, 1e-9) * 1.12;
  const axisY = y + h;
  // gridlines
  doc.save().lineWidth(0.5);
  for (let i = 1; i <= 4; i++) {
    const gy = axisY - (h * i / 4);
    doc.moveTo(x, gy).lineTo(x + w, gy).strokeColor('#EDF0F4').stroke();
    doc.font('Helvetica').fontSize(6).fillColor('#9AA1AC').text(vf(max * i / 4), x - 34, gy - 2, { width: 30, align: 'right' });
  }
  const n = data.length, slot = w / n, bw = Math.min(slot * 0.62, 46);
  data.forEach((d, i) => {
    const bh = (d.value / max) * h;
    const bx = x + i * slot + (slot - bw) / 2;
    doc.rect(bx, axisY - bh, bw, bh).fill(opts.color ? (typeof opts.color === 'function' ? opts.color(d, i) : opts.color) : PALETTE[0]);
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#14181F')
       .text(vf(d.value), bx - 6, axisY - bh - 9, { width: bw + 12, align: 'center' });
    doc.font('Helvetica').fontSize(6).fillColor('#69707C')
       .text(String(d.label).slice(0, 12), bx - 8, axisY + 3, { width: bw + 16, align: 'center' });
  });
  if (opts.targetLine) {
    const ty = axisY - (opts.targetLine / max) * h;
    doc.save().moveTo(x, ty).lineTo(x + w, ty).dash(3, { space: 2 }).lineWidth(1).strokeColor('#C22F2F').stroke().undash().restore();
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#C22F2F')
       .text('target ' + vf(opts.targetLine), x + w - 70, ty - 9, { width: 70, align: 'right' });
  }
  doc.moveTo(x, axisY).lineTo(x + w, axisY).lineWidth(1).strokeColor('#C9CED6').stroke().restore();
}

// Donut chart with legend. data: [{label, value}]
function pdfDonut(doc, cx, cy, r, data, opts = {}) {
  const total = data.reduce((a, d) => a + Math.max(d.value, 0), 0) || 1;
  let ang = -Math.PI / 2;
  data.forEach((d, i) => {
    const frac = Math.max(d.value, 0) / total;
    if (frac <= 0) return;
    const a2 = ang + frac * Math.PI * 2;
    const large = (a2 - ang) > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(ang), y1 = cy + r * Math.sin(ang);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    doc.path(`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`).fill(PALETTE[i % PALETTE.length]);
    ang = a2;
  });
  doc.circle(cx, cy, r * 0.55).fill('#FFFFFF');
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#14181F')
     .text(kfmt(total), cx - r, cy - 8, { width: r * 2, align: 'center' });
  doc.font('Helvetica').fontSize(6).fillColor('#69707C')
     .text(opts.centerLabel || 'total', cx - r, cy + 2, { width: r * 2, align: 'center' });
  // legend to the right
  let ly = cy - r;
  const lx = cx + r + 14;
  data.forEach((d, i) => {
    const pct = (100 * Math.max(d.value, 0) / total).toFixed(1);
    doc.rect(lx, ly, 7, 7).fill(PALETTE[i % PALETTE.length]);
    doc.font('Helvetica').fontSize(6.8).fillColor('#14181F')
       .text(`${String(d.label).slice(0, 26)}  ·  ${pct}%`, lx + 11, ly + 0.5, { width: 170 });
    ly += 11.5;
  });
}


// Grouped bars: groups = [{label, values:[{label, value}]}] — bars per series inside each group
function pdfGroupedBars(doc, x, y, w, h, groups, seriesLabels, opts = {}) {
  const vf = opts.valueFmt || kfmt;
  const max = Math.max(...groups.flatMap(g => g.values.map(v => v.value)), 1e-9) * 1.15;
  const axisY = y + h;
  doc.save().lineWidth(0.5);
  for (let i = 1; i <= 4; i++) {
    const gy = axisY - (h * i / 4);
    doc.moveTo(x, gy).lineTo(x + w, gy).strokeColor('#EDF0F4').stroke();
    doc.font('Helvetica').fontSize(6).fillColor('#9AA1AC').text(vf(max * i / 4), x - 34, gy - 2, { width: 30, align: 'right' });
  }
  const slot = w / groups.length;
  groups.forEach((g, gi) => {
    const n = g.values.length, bw = Math.min((slot * 0.8) / n, 22);
    const start = x + gi * slot + (slot - bw * n) / 2;
    g.values.forEach((v, i) => {
      const bh = (v.value / max) * h;
      doc.rect(start + i * bw, axisY - bh, bw - 1.5, bh).fill(PALETTE[i % PALETTE.length]);
      if (bh > 12 && n <= 4)
        doc.font('Helvetica').fontSize(5.4).fillColor('#14181F')
           .text(vf(v.value), start + i * bw - 5, axisY - bh - 8, { width: bw + 10, align: 'center' });
    });
    doc.font('Helvetica').fontSize(6).fillColor('#69707C')
       .text(String(g.label).slice(0, 16), x + gi * slot, axisY + 3, { width: slot, align: 'center' });
  });
  doc.moveTo(x, axisY).lineTo(x + w, axisY).lineWidth(1).strokeColor('#C9CED6').stroke().restore();
  // legend
  let lx = x;
  seriesLabels.forEach((sl, i) => {
    doc.rect(lx, y - 12, 7, 7).fill(PALETTE[i % PALETTE.length]);
    doc.font('Helvetica').fontSize(6.5).fillColor('#14181F').text(sl, lx + 10, y - 11.5);
    lx += 10 + doc.widthOfString(sl) + 16;
  });
}

function pdfHeader(doc, title, sub) {
  doc.rect(0, 0, doc.page.width, 64).fill('#23386B');
  doc.fill('#FFFFFF').font('Helvetica-Bold').fontSize(15).text('SPARES LEDGER', 40, 16);
  doc.font('Helvetica').fontSize(8.5).fillColor('#C9D2E6').text(sub || 'Interloop · Knitting', 40, 36);
  doc.fontSize(8.5).text(`Generated ${new Date().toISOString().slice(0, 10)}`, 40, 16, { width: doc.page.width - 80, align: 'right' });
  doc.fillColor('#14181F').font('Helvetica-Bold').fontSize(13).text(title, 40, 80);
  return 100;
}

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

  let hds = db.prepare('SELECT DISTINCT hd_code FROM stores ORDER BY hd_code').all().map(r => r.hd_code);
  if (q.hd) { const sel = new Set(String(q.hd).split('||')); hds = hds.filter(h => sel.has(h)); }
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
  const alerts = checkFY(fyOf(date_from)) || 0;
  res.json({ ok: true, saved: toSave.length, alerts_generated: alerts });
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
    bustMeta();
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
  bustMeta();
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
  const alerts = n ? (checkFY(y) || 0) : 0;
  res.json({ ok: true, saved: n, alerts_generated: alerts });
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

// Re-check a fiscal year after targets or machine days are saved (dedup-safe):
// alerts fire for breaches that don't already have an identical alert.
function checkFY(fyStart) {
  try {
    const f = `${fyStart}-07-01`, t = `${fyStart + 1}-06-30`;
    const dr = db.prepare('SELECT MIN(tran_date) a, MAX(tran_date) b FROM transactions WHERE tran_date BETWEEN ? AND ?').get(f, t);
    if (!dr.a) return;
    const from = dr.a, to = dr.b;                       // clip to actual data
    const targets = Object.fromEntries(db.prepare('SELECT hd_code, target_rate FROM targets WHERE fy_start=?')
                                         .all(fyStart).map(r => [r.hd_code, r.target_rate]));
    if (!Object.keys(targets).length) return;
    const mdays = machineDaysBetween(from, to);
    const cost = db.prepare(`SELECT s.hd_code AS hd, SUM(t.value) AS cost
                             FROM transactions t JOIN stores s ON s.warehouse_code=t.warehouse_code
                             WHERE t.tran_date BETWEEN ? AND ? GROUP BY s.hd_code`).all(from, to);
    const exists = db.prepare(`SELECT 1 FROM alerts WHERE hd_code=? AND period_from=? AND period_to=? AND target_rate=?`);
    const ins = db.prepare(`INSERT INTO alerts (hd_code, period_from, period_to, actual_rate, target_rate, message)
                            VALUES (?,?,?,?,?,?)`);
    const created = [];
    for (const r of cost) {
      const tg = targets[r.hd], md = mdays[r.hd];
      if (!tg || !md) continue;
      const rate = +(r.cost / md).toFixed(2);
      if (rate <= tg) continue;
      if (exists.get(r.hd, from, to, tg)) continue;     // already alerted for this exact state
      const pct = ((rate / tg - 1) * 100).toFixed(1);
      const msg = `${r.hd}: ${rate} PKR/machine day for ${from}..${to} — ${pct}% ABOVE the ${fyLabel(fyStart)} target of ${tg}. See Target analysis for the full breakdown.`;
      ins.run(r.hd, from, to, rate, tg, msg);
      created.push({ hd: r.hd, pct, message: msg });
    }
    emailAlerts(created);
    return created.length;
  } catch (e) { console.error('FY check failed:', e.message); }
}

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
  sendPush(created);
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



// ---------- Web push notifications (installed app, phone/desktop) ----------
const webpush = require('web-push');
db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
  sub_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  sub_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

function getVapid() {
  let pub = db.prepare("SELECT value FROM app_meta WHERE key='vapid_pub'").get();
  let priv = db.prepare("SELECT value FROM app_meta WHERE key='vapid_priv'").get();
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    db.prepare("INSERT OR REPLACE INTO app_meta (key,value) VALUES ('vapid_pub',?),('vapid_priv',?)")
      .run(keys.publicKey, keys.privateKey);
    pub = { value: keys.publicKey }; priv = { value: keys.privateKey };
  }
  return { publicKey: pub.value, privateKey: priv.value };
}
const VAPID = getVapid();
webpush.setVapidDetails('mailto:alerts@spares-ledger.local', VAPID.publicKey, VAPID.privateKey);

app.get('/api/push/key', requireAuth, (req, res) => res.json({ key: VAPID.publicKey }));
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription.' });
  db.prepare(`INSERT INTO push_subs (user_id, endpoint, sub_json) VALUES (?,?,?)
              ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, sub_json=excluded.sub_json`)
    .run(req.user.user_id, sub.endpoint, JSON.stringify(sub));
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  if (req.body && req.body.endpoint) db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(req.body.endpoint);
  res.json({ ok: true });
});

function sendPush(newAlerts) {
  if (!newAlerts.length) return;
  const subs = db.prepare(`SELECT ps.sub_id, ps.sub_json, u.role, u.hd_code
                           FROM push_subs ps JOIN users u ON u.user_id = ps.user_id WHERE u.active = 1`).all();
  for (const s of subs) {
    const mine = newAlerts.filter(a => s.role !== 'plant' || !s.hd_code || a.hd === s.hd_code);
    if (!mine.length) continue;
    const payload = JSON.stringify({
      title: mine.length === 1 ? `⚠ ${mine[0].hd} above target (${mine[0].pct}%)`
                               : `⚠ ${mine.length} divisions above target`,
      body: mine.map(a => a.message.split(' See Target analysis')[0]).join('\n').slice(0, 400),
    });
    webpush.sendNotification(JSON.parse(s.sub_json), payload).catch(err => {
      if (err.statusCode === 404 || err.statusCode === 410)
        db.prepare('DELETE FROM push_subs WHERE sub_id=?').run(s.sub_id);   // dead device subscription
      else console.error('push failed:', err.statusCode || err.message);
    });
  }
}

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
app.get('/api/admin/downtime', requireRole('admin'), (req, res) => {
  res.json(db.prepare('SELECT * FROM downtime ORDER BY date_from DESC, hd_code').all());
});
app.post('/api/admin/downtime', requireRole('admin'), (req, res) => {
  const { hd_code, date_from, date_to, factor, note } = req.body || {};
  const DR = /^\d{4}-\d{2}-\d{2}$/;
  const hds = new Set(db.prepare('SELECT DISTINCT hd_code FROM stores').all().map(r => r.hd_code));
  if (!hds.has(hd_code)) return res.status(400).json({ error: 'Pick a division.' });
  if (!DR.test(date_from || '') || !DR.test(date_to || '') || date_from > date_to)
    return res.status(400).json({ error: 'Provide a valid date range (from ≤ to).' });
  const fct = Number(factor);
  if (!isFinite(fct) || fct < 0 || fct > 1)
    return res.status(400).json({ error: 'Capacity must be between 0% and 100%.' });
  db.prepare('INSERT INTO downtime (hd_code, date_from, date_to, factor, note) VALUES (?,?,?,?,?)')
    .run(hd_code, date_from, date_to, fct, note || null);
  res.json({ ok: true });
});
app.post('/api/admin/downtime/:id/delete', requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM downtime WHERE dt_id=?').run(+req.params.id);
  res.json({ ok: true });
});

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


// ---------- Plant comparison PDF (charts + matrix) ----------
app.get('/api/report-compare.pdf', requireAuth, (req, res) => {
  if (req.user.role === 'plant') return res.status(403).json({ error: 'Not available for plant users.' });
  const dim = req.query.dim === 'item' ? 'item' : 'category';
  const col = dim === 'item' ? 'item_code' : 'sp_category';
  const q = { ...req.query };
  const { where, params } = whereClause(q);
  const raw = db.prepare(`SELECT ${col} AS key, ${dim === 'item' ? 'MIN(item_description) AS desc,' : ''}
      hd_code, ROUND(SUM(value),2) AS cost FROM v_consumption ${where} GROUP BY ${col}, hd_code`).all(...params);
  const hdTotals = db.prepare(`SELECT hd_code, ROUND(SUM(value),2) AS cost FROM v_consumption ${where}
      GROUP BY hd_code ORDER BY hd_code`).all(...params);
  const mdays = machineDaysBetween(q.from, q.to);
  const hds = hdTotals.map(r => r.hd_code);
  const focusKeys = q.focus ? String(q.focus).split('||').slice(0, 6) : [];
  const byKey = new Map();
  for (const r of raw) {
    if (!byKey.has(r.key)) byKey.set(r.key, { key: r.key, desc: r.desc, per_hd: {}, total: 0 });
    const o = byKey.get(r.key); o.per_hd[r.hd_code] = r.cost; o.total += r.cost;
  }
  const rows = [...byKey.values()].sort((a, b) => b.total - a.total).slice(0, 18);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="plant-comparison-${q.from || ''}-${q.to || ''}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margins: { top: 46, bottom: 46, left: 40, right: 40 } });
  doc.pipe(res);
  const W = doc.page.width - 80, X = 40;
  let y = pdfHeader(doc, `Plant comparison — by ${dim}`, 'Interloop · Knitting · spare-parts consumption');
  doc.font('Helvetica').fontSize(9).fillColor('#69707C')
     .text(`Period: ${q.from || 'start'} to ${q.to || 'end'}`, X, y); y += 18;

  // chart row: bleed by HD bars + share donut
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#14181F').text('Total bleed by division (PKR)', X, y);
  doc.text('Share of company bleed', X + W * 0.56, y); y += 14;
  pdfBarChart(doc, X + 34, y, W * 0.46 - 34, 110, hdTotals.map(r => ({ label: r.hd_code, value: r.cost })),
              { color: (d, i) => PALETTE[i % PALETTE.length] });
  pdfDonut(doc, X + W * 0.56 + 55, y + 55, 52, hdTotals.map(r => ({ label: r.hd_code, value: r.cost })), { centerLabel: 'PKR' });
  y += 145;

  // per-machine-day bars if machine days exist
  const rates = hdTotals.filter(r => mdays[r.hd_code]).map(r => ({ label: r.hd_code, value: +(r.cost / mdays[r.hd_code]).toFixed(2) }));
  if (rates.length) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#14181F').text('Cost per machine day (PKR) — the fair comparison', X, y); y += 14;
    pdfBarChart(doc, X + 34, y, W - 34, 95, rates, { color: '#C22F2F', valueFmt: v => v.toFixed(1) });
    y += 130;
  }

  // focus charts: one or several chosen categories/items across the selected divisions
  const frs = focusKeys.map(k => byKey.get(k)).filter(Boolean);
  if (frs.length === 1) {
    const fr = frs[0], focus = fr.key;
    if (y > doc.page.height - 240) { doc.addPage(); y = 50; }
    const fLabel = dim === 'item' ? `${focus}${fr.desc ? ' — ' + String(fr.desc).slice(0, 60) : ''}` : focus;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#14181F')
       .text(`Focus: ${fLabel} — cost by division (PKR)`, X, y); y += 14;
    pdfBarChart(doc, X + 34, y, W - 34, 100,
      hds.map(h => ({ label: h, value: fr.per_hd[h] || 0 })), { color: (d, i) => PALETTE[i % PALETTE.length] });
    y += 128;
    const fRates = hds.filter(h => mdays[h]).map(h => ({ label: h, value: +(((fr.per_hd[h] || 0)) / mdays[h]).toFixed(2) }));
    if (fRates.length) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#14181F')
         .text(`Focus: ${dim === 'item' ? focus : fLabel} — PKR per machine day`, X, y); y += 14;
      pdfBarChart(doc, X + 34, y, W - 34, 85, fRates, { color: '#C22F2F', valueFmt: v => v.toFixed(2) });
      y += 115;
    }
  } else if (frs.length > 1) {
    if (y > doc.page.height - 260) { doc.addPage(); y = 50; }
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#14181F')
       .text(`Focus comparison — cost by division (PKR)`, X, y); y += 20;
    pdfGroupedBars(doc, X + 34, y, W - 34, 105,
      frs.map(fr => ({ label: fr.key, values: hds.map(h => ({ label: h, value: fr.per_hd[h] || 0 })) })), hds);
    y += 132;
    if (hds.every(h => mdays[h])) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#14181F')
         .text(`Focus comparison — PKR per machine day`, X, y); y += 20;
      pdfGroupedBars(doc, X + 34, y, W - 34, 90,
        frs.map(fr => ({ label: fr.key, values: hds.map(h => ({ label: h, value: +(((fr.per_hd[h] || 0)) / mdays[h]).toFixed(2) })) })),
        hds, { valueFmt: v => v.toFixed(1) });
      y += 118;
    }
    if (dim === 'item') {
      doc.font('Helvetica').fontSize(6.5).fillColor('#69707C');
      frs.forEach(fr => { doc.text(`${fr.key} — ${String(fr.desc || '').slice(0, 90)}`, X, y); y += 8.5; });
      y += 4;
    }
  }
  // matrix table
  if (y > doc.page.height - 200) { doc.addPage(); y = 50; }
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#14181F').text(`Top ${rows.length} ${dim === 'item' ? 'items' : 'categories'} across divisions (PKR)`, X, y); y += 12;
  const keyW = dim === 'item' ? 150 : 120;
  const cw = (W - keyW - 55) / hds.length;
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#69707C');
  doc.text(dim.toUpperCase(), X, y, { width: keyW });
  hds.forEach((h, i) => doc.text(h, X + keyW + i * cw, y, { width: cw, align: 'right' }));
  doc.text('TOTAL', X + keyW + hds.length * cw, y, { width: 55, align: 'right' });
  y += 9; doc.moveTo(X, y).lineTo(X + W, y).strokeColor('#DDE1E7').lineWidth(0.5).stroke(); y += 3;
  const BOTTOM = doc.page.height - 56;
  for (const r of rows) {
    if (y > BOTTOM - 12) { doc.addPage(); y = 50; }
    const mx = Math.max(...hds.map(h => r.per_hd[h] || 0), 1e-9);
    doc.font('Helvetica').fontSize(6.8).fillColor('#14181F').text(String(r.key).slice(0, dim === 'item' ? 38 : 26), X, y, { width: keyW, lineBreak: false });
    hds.forEach((h, i) => {
      const v = r.per_hd[h];
      if (v) {
        const a = 0.08 + 0.30 * (v / mx);
        doc.save().fillOpacity(a).rect(X + keyW + i * cw + 2, y - 1.5, cw - 4, 10).fill('#C22F2F').restore();
      }
      doc.font('Helvetica').fontSize(6.8).fillColor(v ? '#14181F' : '#B6BCC6')
         .text(v ? kfmt(v) : '—', X + keyW + i * cw, y, { width: cw, align: 'right' });
    });
    doc.font('Helvetica-Bold').text(kfmt(r.total), X + keyW + hds.length * cw, y, { width: 55, align: 'right' });
    y += 12;
  }
  doc.font('Helvetica').fontSize(6.5).fillColor('#69707C')
     .text('Cell shading is relative within each row — the darkest cell is that row\'s heaviest division.', X, Math.min(y + 6, BOTTOM));
  doc.end();
});

// ---------- Target analysis PDF (rate-vs-target chart + attribution) ----------
app.get('/api/report-targets.pdf', requireAuth, (req, res) => {
  const q = scopeToUser(req);
  const hd = q.hd, bucket = ['day', 'week', 'month'].includes(q.bucket) ? q.bucket : 'month';
  if (!hd || !q.from || !q.to) return res.status(400).json({ error: 'hd, from and to required.' });
  const { fy, targets } = targetsForRange(q.from, q.to);
  const target = fy !== null ? targets[hd] : undefined;
  if (target === undefined) return res.status(400).json({ error: 'No target for this division/FY (or range spans two FYs).' });
  const bucketExpr = bucket === 'day' ? 'tran_date' : bucket === 'week' ? "strftime('%Y-W%W', tran_date)" : "substr(tran_date,1,7)";
  const rows = db.prepare(`SELECT ${bucketExpr} AS b, MIN(tran_date) AS d1, MAX(tran_date) AS d2, SUM(t.value) AS cost
      FROM transactions t JOIN stores s ON s.warehouse_code=t.warehouse_code
      WHERE s.hd_code=? AND t.tran_date BETWEEN ? AND ? GROUP BY ${bucketExpr} ORDER BY b`).all(hd, q.from, q.to);
  const buckets = rows.map(r => {
    const md = machineDaysBetween(r.d1, r.d2)[hd] || null;
    return { b: r.b, d1: r.d1, d2: r.d2, cost: r.cost, md, rate: md ? +(r.cost / md).toFixed(2) : null };
  });
  const above = buckets.filter(b => b.rate !== null && b.rate > target);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="target-analysis-${hd}-${q.from}-${q.to}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margins: { top: 46, bottom: 46, left: 40, right: 40 } });
  doc.pipe(res);
  const W = doc.page.width - 80, X = 40;
  let y = pdfHeader(doc, `Target analysis — ${hd}`, 'Interloop · Knitting · cost per machine day vs target');
  doc.font('Helvetica').fontSize(9).fillColor('#69707C')
     .text(`Period: ${q.from} to ${q.to}   ·   ${fyLabel(fy)} target: ${target} PKR/machine day   ·   ${bucket}ly view`, X, y); y += 18;

  const chartData = buckets.filter(b => b.rate !== null).map(b => ({ label: b.b.replace('2025-','').replace('2026-',''), value: b.rate }));
  if (chartData.length) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#14181F').text('Rate vs target (PKR / machine day)', X, y); y += 14;
    pdfBarChart(doc, X + 34, y, W - 34, 120, chartData,
      { color: d => d.value > target ? '#C22F2F' : '#5B8C5A', targetLine: target, valueFmt: v => v.toFixed(1) });
    y += 155;
  }

  if (above.length) {
    const ranges = above.map(b => [b.d1, b.d2]);
    const inRange = ranges.map(() => '(t.tran_date BETWEEN ? AND ?)').join(' OR ');
    const rp = ranges.flat();
    const mdW = above.reduce((a, b) => a + (b.md || 0), 0);
    const actualW = above.reduce((a, b) => a + b.cost, 0);
    const expectedW = target * mdW;
    const base = db.prepare(`SELECT i.sp_category k, SUM(t.value) v FROM transactions t
        JOIN stores s ON s.warehouse_code=t.warehouse_code JOIN items i ON i.item_code=t.item_code
        WHERE s.hd_code=? AND t.tran_date BETWEEN ? AND ? GROUP BY 1`).all(hd, q.from, q.to);
    const bt = base.reduce((a, r) => a + r.v, 0) || 1;
    const share = Object.fromEntries(base.map(r => [r.k, r.v / bt]));
    const catW = db.prepare(`SELECT i.sp_category k, SUM(t.value) v FROM transactions t
        JOIN stores s ON s.warehouse_code=t.warehouse_code JOIN items i ON i.item_code=t.item_code
        WHERE s.hd_code=? AND (${inRange}) GROUP BY 1`).all(hd, ...rp);
    const cats = catW.map(r => ({ label: r.k, actual: r.v, expected: (share[r.k] || 0) * expectedW,
                                  value: r.v - (share[r.k] || 0) * expectedW }))
                     .sort((a, b) => b.value - a.value);
    const excess = actualW - expectedW;

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#14181F')
       .text(`Deviating ${bucket}s: ${above.map(b => b.b).join(', ')}`, X, y); y += 12;
    doc.font('Helvetica').fontSize(8).fillColor('#14181F')
       .text(`Actual ${kfmt(actualW)} vs expected at target ${kfmt(expectedW)} → excess `, X, y, { continued: true })
       .font('Helvetica-Bold').fillColor('#C22F2F').text(`${kfmt(excess)} PKR`); y += 18;

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#14181F').text('Excess by category', X, y); y += 14;
    pdfDonut(doc, X + 65, y + 55, 52, cats.filter(c => c.value > 0).slice(0, 8), { centerLabel: 'excess PKR' });
    // table beside donut
    let ty = y; const tx = X + 300;
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#69707C');
    doc.text('CATEGORY', tx, ty, { width: 110 }); doc.text('ACTUAL', tx + 110, ty, { width: 45, align: 'right' });
    doc.text('EXPECTED', tx + 155, ty, { width: 45, align: 'right' }); doc.text('EXCESS', tx + 200, ty, { width: 45, align: 'right' });
    ty += 9;
    for (const c of cats.slice(0, 10)) {
      doc.font('Helvetica').fontSize(6.8).fillColor('#14181F').text(String(c.label).slice(0, 24), tx, ty, { width: 110, lineBreak: false });
      doc.text(kfmt(c.actual), tx + 110, ty, { width: 45, align: 'right' });
      doc.text(kfmt(c.expected), tx + 155, ty, { width: 45, align: 'right' });
      doc.font('Helvetica-Bold').fillColor(c.value > 0 ? '#C22F2F' : '#5B8C5A')
         .text((c.value > 0 ? '+' : '') + kfmt(c.value), tx + 200, ty, { width: 45, align: 'right' });
      ty += 10.5;
    }
    y = Math.max(y + 130, ty + 10);

    const mach = db.prepare(`SELECT s.store_name || ' · ' || m.short_desc k, SUM(t.value) v, COUNT(*) n
        FROM transactions t JOIN stores s ON s.warehouse_code=t.warehouse_code
        JOIN machines m ON m.machine_id=t.machine_id
        WHERE s.hd_code=? AND (${inRange}) GROUP BY t.machine_id ORDER BY v DESC LIMIT 10`).all(hd, ...rp);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#14181F').text('Top machines in the deviating window', X, y); y += 14;
    pdfBarChart(doc, X + 34, y, W - 34, 95,
      mach.map(m => ({ label: m.k.split(' · ').pop(), value: m.v })), { color: '#23386B' });
    y += 120;
  } else {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#5B8C5A')
       .text(`Within budget: no ${bucket} exceeded the target in this period. ✓`, X, y); y += 20;
  }
  doc.font('Helvetica').fontSize(6.5).fillColor('#69707C')
     .text('Green bars are within target; red bars exceed it. Machine days pro-rated from admin-entered ranges.', X, y);
  doc.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Spares dashboard on http://localhost:${PORT}`));
