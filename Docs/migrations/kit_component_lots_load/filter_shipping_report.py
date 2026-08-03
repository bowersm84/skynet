#!/usr/bin/env python3
"""
filter_shipping_report.py — Kit component-lot backfill filter (D-KSTC-25)

Reads the Fishbowl "Shipping Report - Tracking Information" export (the
curated per-lot version, 2026-08-03 format) and emits the load CSV for
kit_lot_component_lots.

Rules:
  1. Kit component rows only: parent_kit_number != product_number.
  2. Drop rows with no lot_number (CUSTOMER NOTES / CATALOG / DHL etc.).
  3. Drop denylisted pseudo-products even if they carry a lot.
  4. Collapse carton fan-out: identical (shipment, line, product, lot, qty)
     rows repeat once per carton/tracking number -> keep one.
  5. After collapse, sum qty per (shipment, line, product, lot) — true
     multi-lot splits arrive as self-consistent per-lot rows.

Re-runnable on future report exports (Fishbowl refresh cycle):
  python filter_shipping_report.py <input.csv> <output.csv>
"""
import sys
import pandas as pd

DENYLIST = {
    'CUSTOMER NOTES', 'CATALOG', 'COUNTRY OF ORIGIN USA', 'DHL', 'FEDEX',
    'UPS', 'FREIGHT', 'MFG CERTS', 'WIRE TRANSFER FEE',
}

def main(inp, outp):
    df = pd.read_csv(inp, dtype=str, encoding='cp1252')
    df.columns = [c.strip() for c in df.columns]

    for col in ('parent_kit_number', 'product_number', 'lot_number',
                'so_number', 'shipment_number', 'so_line_no'):
        df[col] = df[col].str.strip()

    total = len(df)
    kit = df[(df['parent_kit_number'].notna()) &
             (df['product_number'].notna()) &
             (df['parent_kit_number'] != df['product_number'])].copy()
    n_kit = len(kit)

    kit = kit[kit['lot_number'].notna() & (kit['lot_number'] != '')]
    n_lotted = len(kit)

    kit = kit[~kit['product_number'].str.upper().isin(DENYLIST)]
    n_clean = len(kit)

    kit['qty'] = pd.to_numeric(kit['qty_shipped'], errors='coerce')
    kit['lqty'] = pd.to_numeric(kit['lot_qty'], errors='coerce')
    kit['ship_date'] = pd.to_datetime(kit['date_shipped'], errors='coerce').dt.date

    # Integrity check: every surviving row must be self-consistent.
    bad = kit[(kit['lqty'].notna()) & (kit['qty'].notna()) & (kit['lqty'] != kit['qty'])]
    if len(bad):
        print(f"WARNING: {len(bad)} rows where lot_qty != qty_shipped "
              f"(unexpected in curated report) — kept, review output.")

    # Carton fan-out collapse, then per-lot aggregation.
    key = ['so_number', 'shipment_number', 'so_line_no',
           'parent_kit_number', 'product_number', 'lot_number']
    kit = kit.drop_duplicates(key + ['qty'])
    agg = (kit.groupby(key, dropna=False)
              .agg(qty_shipped=('qty', 'sum'), ship_date=('ship_date', 'min'))
              .reset_index())

    agg = agg.rename(columns={'product_number': 'part_number',
                              'parent_kit_number': 'parent_kit'})
    agg = agg[['so_number', 'shipment_number', 'ship_date', 'so_line_no',
               'parent_kit', 'part_number', 'lot_number', 'qty_shipped']]
    agg.to_csv(outp, index=False)

    print(f"input rows:            {total:>7}")
    print(f"kit component rows:    {n_kit:>7}")
    print(f"with lot numbers:      {n_lotted:>7}")
    print(f"after denylist:        {n_clean:>7}")
    print(f"load rows written:     {len(agg):>7}")
    print(f"distinct SOs:          {agg['so_number'].nunique():>7}")
    print(f"distinct parent kits:  {agg['parent_kit'].nunique():>7}")
    print(f"ship dates:            {agg['ship_date'].min()} -> {agg['ship_date'].max()}")

if __name__ == '__main__':
    a = sys.argv
    main(a[1] if len(a) > 1 else 'Shipping_Report_-_Tracking_Information-3.csv',
         a[2] if len(a) > 2 else 'kit_component_lots_load.csv')
