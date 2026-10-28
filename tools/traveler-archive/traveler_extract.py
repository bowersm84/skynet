#!/usr/bin/env python3
"""Skybolt traveler extractor — walks Year/Month/ORDER(PART)/ folders, reads every Form 10-100 Work
Traveler workbook, and writes runs.csv (one row per machine run), ops.csv (every operation row),
exceptions.csv and skipped.csv.

Usage:  python traveler_extract.py <root_dir> <out_dir> [--all] [--from <earlier skipped.csv>]

<root_dir> can be one month, one year, or the whole archive (e.g. the Travelers-Post-10-1-21 folder on
Google Drive for desktop). Only spreadsheets are opened, and numbered quality forms / drawings
(e.g. "252 SK4P Stud Headed Rev.xls", "15 Drawing SK4P ...xls") are skipped by name, so Drive only has
to stream the travelers themselves. --all opens every spreadsheet (slower; use if a traveler is missed).
--from <skipped.csv> reprocesses only the files an earlier run skipped that the current rules would open.
Needs: pip install openpyxl xlrd pandas
"""
import sys, os, re, csv, json, glob, datetime, warnings
from collections import defaultdict
warnings.filterwarnings("ignore")
from openpyxl import load_workbook

MONTHS = {m.lower(): i for i, m in enumerate(["January","February","March","April","May","June","July","August","September","October","November","December"], 1)}

def norm(v):
    if isinstance(v, str):
        v = v.strip()
        return v if v else None
    return v

def folder_meta(path, root):
    """year, month from any ancestor folder like 'December 2021' or '2021'; order/part from 'ORDER(PART)'."""
    rel = os.path.relpath(path, root)
    year = month = None
    order = part = None
    for seg in rel.split(os.sep):
        m = re.match(r"^\s*([A-Za-z]+)\s+(\d{4})\s*$", seg)                     # "December 2021"
        if m and m.group(1).lower() in MONTHS:
            month, year = MONTHS[m.group(1).lower()], int(m.group(2)); continue
        m = re.match(r"^\s*(\d{1,2})\s+[A-Za-z]+(?:\s+(\d{4}))?\s*$", seg)        # "1 Janurary 2022", "09 September"
        if m and 1 <= int(m.group(1)) <= 12:
            month = int(m.group(1))
            if m.group(2): year = int(m.group(2))
            continue
        if re.match(r"^\d{4}$", seg): year = int(seg); continue
        m = re.match(r"^\s*([^()]*?)\s*\((.+)\)\s*$", seg)
        if m:
            order, part = m.group(1).strip() or None, m.group(2).strip()
    return year, month, order, part

MACHINE_RULES = [
    (re.compile(r"next[\s-]*turn[\s-]*(\d+)?", re.I), "Nexturn"),
    (re.compile(r"nexturn\s*(\d+)?", re.I), "Nexturn"),
    (re.compile(r"bolt\s*master\s*(\d+)?", re.I), "Bolt Master"),
    (re.compile(r"mazak\s*(\d+)?", re.I), "Mazak"),
    (re.compile(r"ganesh\s*(\d+)?", re.I), "Ganesh"),
]
ABBREV = [  # whole-field shorthand used on travelers from 2022 on
    (re.compile(r"^M\s*/?\s*(\d+)?$", re.I), "Mazak"),
    (re.compile(r"^NT?\s*(\d+)?$", re.I), "Nexturn"),
    (re.compile(r"^BM?\s*(\d+)?$", re.I), "Bolt Master"),
    (re.compile(r"^G\s*(\d+)?$", re.I), "Ganesh"),
]
ROMAN = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7}

def _one_machine(s):
    s = s.strip()
    for rx, name in ABBREV:
        m = rx.match(s)
        if m:
            n = m.group(1)
            if n: return f"{name} {int(n)}", "ok"
            if name == "Ganesh": return "Ganesh 1", "ok"
            return f"{name} ?", "no_number"
    m = re.match(r"^(mazak|next\s*turn|nexturn|bolt\s*master|boltmaster)\s+([ivx]+)$", s, re.I)
    if m and m.group(2).lower() in ROMAN:
        s = f"{m.group(1)} {ROMAN[m.group(2).lower()]}"
    s = re.sub(r"boltmaster", "Bolt Master", s, flags=re.I)
    for rx, name in MACHINE_RULES:
        m = rx.search(s)
        if m:
            n = m.group(1)
            if n: return f"{name} {int(n)}", "ok"
            if name == "Ganesh": return "Ganesh 1", "ok"   # only one Ganesh has ever been on the floor
            return f"{name} ?", "no_number"
    return None, "unmapped"

def normalize_machine(raw):
    """Returns (machine, match). Multi-machine entries ('M4/M5', 'N3/4', 'BM2/BM4') return the first machine
    with match 'multi'; the full list is kept by machine_list()."""
    if not raw: return None, "missing"
    lst = machine_list(raw)
    if len(lst) > 1: return lst[0], "multi"
    if len(lst) == 1: return lst[0], ("ok" if not lst[0].endswith("?") else "no_number")
    return str(raw).strip(), "unmapped"

def machine_list(raw):
    s = str(raw).strip()
    parts = [p for p in re.split(r"\s*[/&,]\s*|\s+and\s+", s) if p]
    out, last_type = [], None
    for p in parts:
        if re.fullmatch(r"\d+", p) and last_type:          # 'N3/4' -> Nexturn 3, Nexturn 4
            out.append(f"{last_type} {int(p)}"); continue
        m, how = _one_machine(p)
        if m: out.append(m); last_type = m.rsplit(" ", 1)[0]
    if not out and "/" in s:
        m, how = _one_machine(s.replace("/", ""))
        if m: out.append(m)
    # 'M/2' -> ['Mazak ?', 'Mazak 2'] -> ['Mazak 2']: an unnumbered entry yields to a numbered one of the same type
    numbered_types = {m.rsplit(" ", 1)[0] for m in out if not m.endswith("?")}
    out = [m for m in out if not (m.endswith("?") and m.rsplit(" ", 1)[0] in numbered_types)]
    return list(dict.fromkeys(out))

def _unused_normalize_machine(raw):
    if not raw: return None, "missing"
    s = str(raw)
    for rx, name in MACHINE_RULES:
        m = rx.search(s)
        if m:
            n = m.group(1)
            if n: return f"{name} {int(n)}", "ok"
            if name == "Ganesh": return "Ganesh 1", "ok"   # only one Ganesh has ever been on the floor
            return f"{name} ?", "no_number"
    return s.strip(), "unmapped"

def parse_date(v):
    if isinstance(v, datetime.datetime): return v.date()
    if isinstance(v, datetime.date): return v
    if isinstance(v, (int, float)) and 30000 < v < 60000:  # excel serial
        return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(v)))
    if isinstance(v, str):
        for fmt in ("%m/%d/%Y", "%m/%d/%y", "%m-%d-%Y", "%m-%d-%y", "%Y-%m-%d"):
            try: return datetime.datetime.strptime(v.strip(), fmt).date()
            except ValueError: pass
    return None

LOT_RX = re.compile(r"(\d{6})(?:\D|$)")
def lot_date(lot):
    """Lot numbers end in MMDDYY (e.g. 2392-121521 -> 2021-12-15)."""
    if lot is None: return None
    m = re.search(r"-(\d{6})\b", str(lot))
    if not m: return None
    s = m.group(1)
    try: return datetime.date(2000 + int(s[4:6]), int(s[0:2]), int(s[2:4]))
    except ValueError: return None

def parse_customer(raw):
    """'KRATOS/220' -> (KRATOS, 220); '200/GIZA' -> (GIZA, 200); 'STOCK' -> (STOCK, None); 'SRI/STOCK' -> (SRI/STOCK, None)."""
    if raw is None: return None, None, None
    s = str(raw).strip()
    parts = [p.strip() for p in re.split(r"[/]", s) if p.strip()]
    qty = None; names = []
    for p in parts:
        q = p.replace(",", "")
        if re.fullmatch(r"\d+", q): qty = int(q)
        else: names.append(p)
    name = "/".join(names) if names else None
    kind = "stock" if name and "stock" in name.lower() and len(names) == 1 else ("order" if name else None)
    return name, qty, kind

def read_cells(ws):
    cells = {}
    for row in ws.iter_rows():
        for c in row:
            v = norm(c.value)
            if v is not None: cells[(c.row, c.column)] = v
    return cells

def find_label(cells, prefix):
    pl = prefix.lower()
    for (r, c), v in cells.items():
        if isinstance(v, str) and v.lower().replace(" ", "").startswith(pl.replace(" ", "")):
            return (r, c)
    return None

def right_of(cells, pos, span=6):
    if not pos: return None
    r, c = pos
    for cc in range(c + 1, c + span + 1):
        if (r, cc) in cells: return cells[(r, cc)]
    return None

def below(cells, pos):
    if not pos: return None
    r, c = pos
    return cells.get((r + 1, c))

def parse_traveler(path, cells):
    pn = find_label(cells, "Part Number")
    if not pn: return None
    hdr = {
        "part_number": below(cells, pn),
        "customer_raw": below(cells, find_label(cells, "Customer")),
        "order_number": below(cells, find_label(cells, "Order Number")),
        "final_process": right_of(cells, find_label(cells, "Final Process")),
        "manufacturing_no": right_of(cells, find_label(cells, "Manufacturing #")),
        "heat_lot": right_of(cells, find_label(cells, "Heat / Lot")),
        "material": below(cells, find_label(cells, "Material")),
        "drawing_rev": below(cells, find_label(cells, "Draw. Rev")),
        "tso_rev": below(cells, find_label(cells, "TSO Rev")),
        "start_date": parse_date(below(cells, find_label(cells, "Start"))),
        "due_date": parse_date(below(cells, find_label(cells, "Due"))),
        "notes": right_of(cells, find_label(cells, "Notes"), span=10),
    }
    ops = []
    for (r, c), v in sorted(cells.items()):
        # op-block header: 'Station/Vendor' (2021-12 on) or plain 'Station' (older form), with Qty + Date in the same row
        if isinstance(v, str) and (v.lower().startswith("station/vendor") or v.strip().lower() == "station") \
           and any(isinstance(cells.get((r, cc)), str) and cells[(r, cc)].lower().startswith("qty") for cc in range(c, c + 12)):
            hmap = {}
            for cc in range(1, 40):
                hv = cells.get((r, cc))
                if isinstance(hv, str): hmap[hv.lower()] = cc
            for rr in (r + 1, r + 2):
                station = cells.get((rr, c))
                if station is None: continue
                proc = None
                for cc in range(c - 1, 0, -1):
                    if (rr, cc) in cells: proc = cells[(rr, cc)]; break
                def at(key):
                    for k, cc in hmap.items():
                        if k.startswith(key): return cells.get((rr, cc))
                    return None
                ops.append({"row": rr, "process": str(proc).strip() if proc else None, "station": str(station).strip(),
                            "lot": at("new lot"), "qty": at("qty"), "date_raw": at("date"), "date": parse_date(at("date")), "operator": at("opr")})
                break
    return hdr, ops

# Numbered quality forms and drawings live beside the traveler in every run folder ("252 SK4P Stud Headed
# Rev.xls", "700.001 QL8C21 ... REV 4.xls", "15 Drawing SK4P ...xls", "Form 10.4-401 Passivation Report
# Master.xlsx"). They are the bulk of the spreadsheet bytes and never hold a traveler, so they are not opened.
# Form numbers are 1-3 digits (252, 016.1, 700.001); from late 2023 on, travelers themselves are named
# "<order number>   <part>_traveler.xlsx", so 4+ digit prefixes and anything named *travel* are always opened.
SKIP_NAME = re.compile(r"^\s*\d{1,3}(?:\.\d+)*\s|drawing|passivation report", re.I)
KEEP_NAME = re.compile(r"travel", re.I)

def main(root, out, open_all=False, from_list=None):
    import time
    os.makedirs(out, exist_ok=True)
    runs, allops, exceptions, skipped = [], [], [], []
    if from_list:
        with open(from_list, newline="", encoding="utf-8") as f:
            rel = [row["file"].replace("\\", os.sep).replace("/", os.sep) for row in csv.DictReader(f)]
        files = sorted(os.path.join(root, r) for r in rel)
    else:
        files = sorted(glob.glob(os.path.join(root, "**", "*.xls*"), recursive=True))
    t0 = time.time(); opened = 0
    for i, path in enumerate(files, 1):
        base = os.path.basename(path)
        if base.startswith("~$"): continue
        if not open_all and SKIP_NAME.search(base) and not KEEP_NAME.search(base):
            skipped.append({"file": os.path.relpath(path, root), "reason": "numbered form / drawing (by name)"}); continue
        opened += 1
        if opened % 25 == 0:
            print(f"  ...{opened} spreadsheets read, {len(runs)} travelers so far ({time.time() - t0:.0f}s)", flush=True)
        year, month, f_order, f_part = folder_meta(os.path.dirname(path), root)
        ext = os.path.splitext(path)[1].lower()
        try:
            if ext == ".xlsx" or ext == ".xlsm":
                wb = load_workbook(path, data_only=True, read_only=False)
                sheets = [(ws.title, read_cells(ws)) for ws in wb.worksheets]
            else:
                import pandas as pd
                xf = pd.ExcelFile(path, engine="xlrd")
                sheets = []
                for sn in xf.sheet_names:
                    df = pd.read_excel(xf, sheet_name=sn, header=None)
                    cells = {}
                    for ri, row in df.iterrows():
                        for ci, v in enumerate(row.values):
                            v = norm(v if not (isinstance(v, float) and v != v) else None)
                            if v is not None: cells[(ri + 1, ci + 1)] = v
                    sheets.append((sn, cells))
        except Exception as e:
            exceptions.append({"file": path, "issue": f"unreadable: {e}"}); continue
        parsed = None
        for sn, cells in sheets:
            p = parse_traveler(path, cells)
            if p: parsed = p; break
        if not parsed:
            continue  # drawings, inspection logs, passivation reports
        hdr, ops = parsed
        # a machine op is any op whose station is a shop machine (process text is sometimes mangled, e.g. 'ak')
        machine_ops = [o for o in ops if normalize_machine(o["station"])[1] in ("ok", "no_number", "multi")
                       or (o["process"] and "machine" in o["process"].lower())]
        rec = {"file": os.path.relpath(path, root), "folder_year": year, "folder_month": month,
               "folder_order": f_order, "folder_part": f_part, **hdr}
        rec["customer_name"], rec["order_qty"], rec["order_kind"] = parse_customer(hdr["customer_raw"])
        rec["part_number"] = str(hdr["part_number"]).strip() if hdr["part_number"] else None
        if rec["part_number"] and f_part and rec["part_number"].upper() != f_part.upper():
            rec["part_mismatch_folder"] = True
        for o in ops:
            allops.append({"file": rec["file"], "order_number": hdr["order_number"], "part_number": rec["part_number"], **{k: v for k, v in o.items() if k != "row"}})
        if not machine_ops:
            if any(o["qty"] for o in ops):
                exceptions.append({"file": rec["file"], "issue": "no machine-process row (ops present)", "detail": "; ".join(f"{o['process']}@{o['station']}" for o in ops)})
            else:
                exceptions.append({"file": rec["file"], "issue": "blank traveler / cover sheet (no quantities)"})
            rec.update({"machine_raw": None, "machine": None, "machine_match": "missing"})
            runs.append(rec); continue
        for mo in machine_ops:
            r = dict(rec)
            r["machine_raw"] = mo["station"]
            r["machine"], r["machine_match"] = normalize_machine(mo["station"])
            r["machine_type"] = r["machine"].rsplit(" ", 1)[0] if r["machine"] and r["machine_match"] != "unmapped" else None
            r["machines_all"] = "|".join(machine_list(mo["station"])) if r["machine_match"] == "multi" else None
            r["qty_produced"] = mo["qty"]; r["run_date_raw"] = mo["date_raw"]; r["run_date"] = mo["date"]
            r["operator"] = mo["operator"]; r["lot_number"] = mo["lot"]; r["lot_date"] = lot_date(mo["lot"])
            # date sanity: year-rollover typo (same month/day as lot date, year one less) and folder window
            flags = []
            d, ld = r["run_date"], r["lot_date"]
            # year-rollover typo: a January/February date typed with last year's year (Excel keeps the year you
            # type). If the date sits far before the lot date and bumping the year lands just after it, bump it.
            if d and ld and d < ld - datetime.timedelta(days=240):
                try: d2 = d.replace(year=d.year + 1)
                except ValueError: d2 = None
                if d2 and ld - datetime.timedelta(days=7) <= d2 <= ld + datetime.timedelta(days=150):
                    r["run_date"] = d2; flags.append(f"year_fixed_from_{d.isoformat()}")
            if d and year and month:
                win_start = datetime.date(year, month, 1) - datetime.timedelta(days=45)
                win_end = datetime.date(year, month, 28) + datetime.timedelta(days=120)
                if not (win_start <= r["run_date"] <= win_end): flags.append("date_outside_folder_window")
            if not d: flags.append("no_run_date")
            if r["machine_match"] != "ok": flags.append(f"machine_{r['machine_match']}")
            r["flags"] = ";".join(flags)
            r["ops_json"] = json.dumps([{k: (v.isoformat() if isinstance(v, (datetime.date, datetime.datetime)) else v) for k, v in o.items() if k not in ("row", "date_raw")} for o in ops], default=str)
            runs.append(r)
    # dedupe: same order+part+machine+qty from different files (cover copies)
    seen = {}
    deduped = []
    for r in runs:
        key = (str(r.get("order_number")), r.get("part_number"), r.get("machine"), str(r.get("qty_produced")))
        if r.get("machine") and key in seen:
            exceptions.append({"file": r["file"], "issue": "duplicate traveler copy", "detail": f"same as {seen[key]}"}); continue
        seen[key] = r["file"]; deduped.append(r)
    def write(name, rows):
        if not rows: open(os.path.join(out, name), "w").write(""); return
        keys = []
        for r in rows:
            for k in r: 
                if k not in keys: keys.append(k)
        with open(os.path.join(out, name), "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=keys); w.writeheader()
            for r in rows: w.writerow({k: (v.isoformat() if isinstance(v, (datetime.date, datetime.datetime)) else v) for k, v in r.items()})
    write("runs.csv", deduped); write("ops.csv", allops); write("exceptions.csv", exceptions); write("skipped.csv", skipped)
    print(f"spreadsheets found: {len(files)}  opened: {opened}  skipped by name: {len(skipped)}  travelers: {len(runs)}  "
          f"runs kept: {len(deduped)}  ops: {len(allops)}  exceptions: {len(exceptions)}  ({time.time() - t0:.0f}s)")
    print(f"output: {os.path.abspath(out)}")
    return deduped, exceptions

if __name__ == "__main__":
    argv = sys.argv[1:]
    from_list = None
    if "--from" in argv:
        i = argv.index("--from"); from_list = argv[i + 1]; del argv[i:i + 2]
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 2:
        print(__doc__); sys.exit(1)
    main(args[0], args[1], open_all="--all" in argv, from_list=from_list)
