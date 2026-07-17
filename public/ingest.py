#!/usr/bin/env python3
"""
Monthly transaction file ingestion for the Interloop spares consumption DB.

Usage:
    python ingest.py <transactions.xlsx> [--db inventory.db]

Behaviour:
- Reads only the agreed (non-red) columns from the monthly dump.
- Normalizes text (trim, uppercase nature/category, canonical machine models).
- Decodes Asset Loc into site / warehouse / cost center / machine number.
- Validates against the store mapping; logs issues to ingest_issues.
- Idempotent per month: if the file's month was loaded before, that month's
  transactions are REPLACED (never doubled).
"""
import sys, re, sqlite3, argparse
from collections import Counter
import pandas as pd

KEEP = ['Interface Date','Warehouse','Item Code','Item Description','Primary UOM Code',
        'SP Nature','SP Category','Actual Cost','Qty Iss','Qty Value','Maint Type',
        'Asset Loc','Shift','Make Model','Short Desc']

ASSET_LOC_RE = re.compile(r'^(?P<site>[^.]+)\.(?P<dept>[^.]+)\.(?P<wh>[^-]+)-(?P<cc>[^-]+)-(?P<mno>.+)$')

def norm_model(raw: str) -> str:
    return re.sub(r'[^A-Z0-9]', '', str(raw).upper())

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('xlsx')
    ap.add_argument('--db', default='inventory.db')
    ap.add_argument('--range-from', dest='rfrom', default=None)
    ap.add_argument('--range-to', dest='rto', default=None)
    args = ap.parse_args()

    all_cols = pd.read_excel(args.xlsx, nrows=0).columns.str.strip()
    missing = [c for c in KEEP if c not in set(all_cols)]
    if missing:
        print("ABORT: the file is missing these required columns "
              f"(headers must match the agreed names exactly): {', '.join(missing)}")
        sys.exit(1)
    df = pd.read_excel(args.xlsx)
    df.columns = df.columns.str.strip()
    df = df[KEEP]                      # only the approved columns — everything else is ignored
    n_raw = len(df)

    # ---------- normalize ----------
    for col in ['Item Code','Item Description','Primary UOM Code','SP Nature','SP Category',
                'Maint Type','Asset Loc','Shift','Make Model','Short Desc']:
        df[col] = df[col].astype(str).str.strip()
    df['SP Nature']   = df['SP Nature'].str.upper()
    df['SP Category'] = df['SP Category'].str.upper()
    df['Maint Type']  = df['Maint Type'].str.upper()
    df['Shift']       = df['Shift'].str.upper()
    df['model_key']   = df['Make Model'].map(norm_model)
    df['tran_date']   = pd.to_datetime(df['Interface Date']).dt.strftime('%Y-%m-%d')

    # ---------- decode Asset Loc ----------
    parts = df['Asset Loc'].str.extract(ASSET_LOC_RE)
    df = pd.concat([df, parts], axis=1)

    # ---------- the file OWNS its own date range ----------
    months = pd.to_datetime(df['Interface Date']).dt.strftime('%Y-%m')
    month_tag = months.mode()[0]                      # kept for reference/reporting
    date_from = df['tran_date'].min()
    date_to   = df['tran_date'].max()
    # Optional declared range: must fully enclose the file's own dates.
    if args.rfrom or args.rto:
        if not (args.rfrom and args.rto):
            print("ABORT: provide both range-from and range-to, or neither."); sys.exit(1)
        if args.rfrom > date_from or args.rto < date_to:
            print(f"ABORT: declared range {args.rfrom}..{args.rto} does not cover the file's "
                  f"transaction dates {date_from}..{date_to}. Fix the range or the file.")
            sys.exit(1)
        date_from, date_to = args.rfrom, args.rto

    con = sqlite3.connect(args.db, timeout=15)
    con.execute('PRAGMA busy_timeout=15000')
    con.execute('PRAGMA foreign_keys = ON')
    cur = con.cursor()

    issues = []  # (severity, row_ref, message)

    # ---------- validations ----------
    known_wh = {r[0] for r in cur.execute('SELECT warehouse_code FROM stores')}
    for idx, row in df.iterrows():
        excel_row = idx + 2
        if pd.isna(row['site']):
            issues.append(('ERROR', excel_row, f"Asset Loc not parseable: {row['Asset Loc']}"))
        elif int(row['wh']) != int(row['Warehouse']):
            issues.append(('WARN', excel_row,
                f"Asset Loc warehouse {row['wh']} != Warehouse col {row['Warehouse']}"))
        if int(row['Warehouse']) not in known_wh:
            issues.append(('ERROR', excel_row, f"Unknown warehouse {row['Warehouse']} (not in stores mapping)"))
        if pd.isna(row['Actual Cost']) or pd.isna(row['Qty Value']):
            issues.append(('WARN', excel_row, f"Missing cost/value for item {row['Item Code']}"))
        # Short Desc digits vs machine no
        m = re.search(r'(\d+)$', str(row['Short Desc']))
        if m and not pd.isna(row['mno']):
            if m.group(1).lstrip('0') != str(row['mno']).lstrip('0'):
                issues.append(('WARN', excel_row,
                    f"Short Desc {row['Short Desc']} digits != Asset Loc machine no {row['mno']}"))

    fatal = [i for i in issues if i[0] == 'ERROR']
    if fatal:
        print(f"ABORT: {len(fatal)} blocking errors. First 5:")
        for s, r, msg in fatal[:5]:
            print(f"  row {r}: {msg}")
        sys.exit(1)

    # ---------- idempotent DATE-RANGE replace ----------
    # This upload owns [date_from, date_to]: any existing transactions inside
    # that range are replaced; transactions outside it are untouched.
    n_replaced = cur.execute("SELECT COUNT(*) FROM transactions WHERE tran_date BETWEEN ? AND ?",
                             (date_from, date_to)).fetchone()[0]
    if n_replaced:
        cur.execute("DELETE FROM transactions WHERE tran_date BETWEEN ? AND ?", (date_from, date_to))
        print(f"Replaced {n_replaced} existing transactions in {date_from}..{date_to}")
    # tidy fully-emptied old uploads out of the history
    cur.execute("""DELETE FROM ingest_issues WHERE upload_id IN
                   (SELECT u.upload_id FROM uploads u
                    WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.upload_id=u.upload_id))""")
    cur.execute("""DELETE FROM uploads WHERE NOT EXISTS
                   (SELECT 1 FROM transactions t WHERE t.upload_id=uploads.upload_id)""")

    # ---------- upsert dimensions ----------
    # items
    items = df.drop_duplicates('Item Code')[['Item Code','Item Description','Primary UOM Code','SP Nature','SP Category']]
    cur.executemany("""INSERT INTO items (item_code, description, uom, sp_nature, sp_category)
                       VALUES (?,?,?,?,?)
                       ON CONFLICT(item_code) DO UPDATE SET
                         description=excluded.description, uom=excluded.uom,
                         sp_nature=excluded.sp_nature, sp_category=excluded.sp_category""",
                    items.values.tolist())

    # models: display = most frequent raw spelling per normalized key
    disp = (df.groupby('model_key')['Make Model']
              .agg(lambda s: Counter(s).most_common(1)[0][0]).reset_index())
    cur.executemany("""INSERT INTO machine_models (model_key, model_display) VALUES (?,?)
                       ON CONFLICT(model_key) DO NOTHING""", disp.values.tolist())

    # cost centers
    ccs = df.drop_duplicates('cc')[['cc','Warehouse']].dropna()
    cur.executemany("""INSERT INTO cost_centers (cc_code, warehouse_code) VALUES (?,?)
                       ON CONFLICT(cc_code) DO NOTHING""",
                    [(r.cc, int(r.Warehouse)) for r in ccs.itertuples()])

    # machines (mode of model/short_desc/cc per warehouse+mno)
    mach = (df.groupby(['Warehouse','mno'])
              .agg(cc=('cc', lambda s: Counter(s).most_common(1)[0][0]),
                   model_key=('model_key', lambda s: Counter(s).most_common(1)[0][0]),
                   short_desc=('Short Desc', lambda s: Counter(s).most_common(1)[0][0]),
                   asset_loc=('Asset Loc', 'first'))
              .reset_index())
    cur.executemany("""INSERT INTO machines (warehouse_code, machine_no, cc_code, model_key, short_desc, asset_loc)
                       VALUES (?,?,?,?,?,?)
                       ON CONFLICT(warehouse_code, machine_no) DO UPDATE SET
                         cc_code=excluded.cc_code, model_key=excluded.model_key,
                         short_desc=excluded.short_desc, asset_loc=excluded.asset_loc""",
                    [(int(r.Warehouse), r.mno, r.cc, r.model_key, r.short_desc, r.asset_loc)
                     for r in mach.itertuples()])

    # machine_id lookup
    mid = {(w, n): i for i, w, n in cur.execute('SELECT machine_id, warehouse_code, machine_no FROM machines')}

    # ---------- upload record ----------
    total_value = float(df['Qty Value'].sum())
    cur.execute("""INSERT INTO uploads (filename, month_tag, row_count, total_value, date_from, date_to)
                   VALUES (?,?,?,?,?,?)""",
                (args.xlsx.split('/')[-1], month_tag, n_raw, total_value, date_from, date_to))
    upload_id = cur.lastrowid

    # ---------- facts ----------
    rows = list(zip([month_tag]*len(df), df['tran_date'], df['Warehouse'].astype(int),
                    [mid[(int(w), n)] for w, n in zip(df['Warehouse'], df['mno'])],
                    df['cc'], df['Item Code'], df['Maint Type'], df['Shift'],
                    df['Qty Iss'].astype(float),
                    df['Actual Cost'].where(df['Actual Cost'].notna(), None),
                    df['Qty Value'].where(df['Qty Value'].notna(), None),
                    [upload_id]*len(df)))
    cur.executemany("""INSERT INTO transactions
        (month_tag, tran_date, warehouse_code, machine_id, cc_code, item_code,
         maint_type, shift, qty_iss, unit_cost, value, upload_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", rows)

    # ---------- issues ----------
    cur.executemany("INSERT INTO ingest_issues (upload_id, severity, row_ref, message) VALUES (?,?,?,?)",
                    [(upload_id, s, r, m) for s, r, m in issues])

    con.commit()
    print(f"Loaded {n_raw} rows for {date_from}..{date_to} | total value {total_value:,.2f} | "
          f"{len(issues)} warnings logged | upload_id={upload_id}")
    con.close()

if __name__ == '__main__':
    main()
