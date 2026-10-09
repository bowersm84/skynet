"""
convert.py - Excel workbook -> PDF print copy, the way Excel prints it.

SkyNet S14 (D-TKIOSK-11a). Production cards stay Excel: that is what Roger
uploads and what SkyNet keeps. This makes a PDF *print copy* beside each one
so the Traveler Kiosk can print it. The Excel file is never modified or saved.

What gets printed: the sheet that was active when the workbook was saved -
the sheet Excel prints on Ctrl+P - with its own print area, orientation,
margins and fit-to-page settings. Every other sheet is HIDDEN for the export,
not deleted, so formulas that read them still calculate. Macros never run and
external links never update.

Headers and footers are made to fit their text. These production cards put
the footer at (or almost at) the bottom margin, which Excel prints fine but
LibreOffice turns into a footer area a few points tall and clips the text out
of - the controlled-form line "REV 004 ... Form 10-150" vanished from the first
real print copies (Oct 7 2026). Turning on dynamic height for the printed
sheet's header and footer brings it back; the body re-fits by a hair.

The active sheet is read from the FILE (xlrd for .xls, openpyxl for .xlsx/.xlsm),
not from LibreOffice: headless LibreOffice does not load an .xls file's saved
view, reports the first sheet as active, and will still print a sheet the file
has tab-selected even when it is hidden (found in testing, Oct 7 2026). The file's
flag wins; LibreOffice's own answer is only the fallback.

LibreOffice runs headless and is driven over UNO on a localhost TCP port
(works in Lambda and in sandboxes that block AF_UNIX). One soffice process is
started on first use and reused across calls; a watchdog kills and restarts
it if a conversion hangs.
"""
import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

import uno
from com.sun.star.beans import PropertyValue

SOFFICE = os.environ.get("SOFFICE_PATH") or shutil.which("soffice") or "/usr/bin/soffice"
UNO_PORT = int(os.environ.get("SOFFICE_UNO_PORT", "2002"))
PROFILE_DIR = Path(os.environ.get("SOFFICE_PROFILE_DIR", "/tmp/lo-profile"))
CONVERT_TIMEOUT_S = int(os.environ.get("CONVERT_TIMEOUT_S", "90"))
START_TIMEOUT_S = 45

EXCEL_EXTS = (".xls", ".xlsx", ".xlsm")

_proc = None
_desktop = None


class ConversionError(Exception):
    pass


def is_excel(name: str) -> bool:
    return name.lower().endswith(EXCEL_EXTS)


def file_active_sheet(path: str):
    """The sheet the workbook was saved on, read from the file. None if unknown."""
    lower = path.lower()
    try:
        if lower.endswith(".xls"):
            import xlrd
            book = xlrd.open_workbook(path, on_demand=True)
            try:
                for i in range(book.nsheets):
                    sh = book.sheet_by_index(i)
                    if getattr(sh, "sheet_visible", 0):   # WINDOW2: the tab showing on save
                        return sh.name
            finally:
                book.release_resources()
        elif lower.endswith((".xlsx", ".xlsm")):
            from openpyxl import load_workbook
            wb = load_workbook(path, read_only=True, keep_links=False)
            try:
                return wb.active.title if wb.active is not None else None
            finally:
                wb.close()
    except Exception:
        return None
    return None


def _fit_header_footer(doc, sheet) -> list:
    """Let the printed sheet's header/footer grow to fit their text. Returns what changed."""
    changed = []
    try:
        style = doc.StyleFamilies.getByName("PageStyles").getByName(sheet.PageStyle)
    except Exception:
        return changed
    for part in ("Header", "Footer"):
        try:
            if getattr(style, f"{part}IsOn") and not getattr(style, f"{part}IsDynamicHeight"):
                setattr(style, f"{part}IsDynamicHeight", True)
                changed.append(part.lower())
        except Exception:
            pass
    return changed


def _prop(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def _start_office():
    global _proc, _desktop
    _stop_office()
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.setdefault("SAL_USE_VCLPLUGIN", "svp")
    env.setdefault("HOME", "/tmp")
    _proc = subprocess.Popen(
        [
            SOFFICE,
            f"-env:UserInstallation={PROFILE_DIR.resolve().as_uri()}",
            "--headless", "--invisible", "--nologo", "--norestore",
            "--nodefault", "--nolockcheck", "--nofirststartwizard",
            f"--accept=socket,host=127.0.0.1,port={UNO_PORT};urp;StarOffice.ComponentContext",
        ],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    local_ctx = uno.getComponentContext()
    resolver = local_ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local_ctx
    )
    deadline = time.time() + START_TIMEOUT_S
    last_err = None
    while time.time() < deadline:
        if _proc.poll() is not None:
            raise ConversionError(f"soffice exited during start (code {_proc.returncode})")
        try:
            ctx = resolver.resolve(
                f"uno:socket,host=127.0.0.1,port={UNO_PORT};urp;StarOffice.ComponentContext"
            )
            _desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
            return
        except Exception as err:  # NoConnectException until soffice is listening
            last_err = err
            time.sleep(0.25)
    raise ConversionError(f"soffice did not start within {START_TIMEOUT_S}s: {last_err}")


def _stop_office():
    global _proc, _desktop
    _desktop = None
    if _proc is not None and _proc.poll() is None:
        _proc.kill()
        try:
            _proc.wait(timeout=10)
        except Exception:
            pass
    _proc = None


def _office():
    if _desktop is None or _proc is None or _proc.poll() is not None:
        _start_office()
    return _desktop


def office_version() -> str:
    try:
        out = subprocess.run([SOFFICE, "--version"], capture_output=True, text=True, timeout=30)
        return out.stdout.strip().splitlines()[0] if out.stdout else "unknown"
    except Exception:
        return "unknown"


def convert(src_path: str, out_path: str) -> dict:
    """Convert one workbook. Returns {sheets, printed_sheet, pages}. Raises ConversionError."""
    src = Path(src_path).resolve()
    out = Path(out_path).resolve()
    if not src.exists():
        raise ConversionError(f"source not found: {src}")
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()

    desktop = _office()
    timed_out = threading.Event()

    def _watchdog():
        timed_out.set()
        _stop_office()  # unblocks the UNO call with a DisposedException

    timer = threading.Timer(CONVERT_TIMEOUT_S, _watchdog)
    timer.start()
    doc = None
    try:
        load_props = (
            _prop("Hidden", True),
            _prop("MacroExecutionMode", 0),   # NEVER_EXECUTE
            _prop("UpdateDocMode", 0),        # NO_UPDATE: external links stay as saved
            _prop("RepairPackage", True),
        )
        doc = desktop.loadComponentFromURL(src.as_uri(), "_blank", 0, load_props)
        if doc is None or not hasattr(doc, "Sheets"):
            raise ConversionError("not a spreadsheet LibreOffice can open")

        sheets = doc.Sheets
        names = list(sheets.ElementNames)
        visible = [n for n in names if sheets.getByName(n).IsVisible]
        active, active_source = file_active_sheet(str(src)), "file"
        if active not in visible:
            try:
                active, active_source = doc.CurrentController.ActiveSheet.Name, "libreoffice"
            except Exception:
                active = None
        if active not in visible:
            active, active_source = (visible[0] if visible else names[0]), "first-visible"

        # Point the view at the printed sheet (so nothing else is tab-selected),
        # then hide - never delete - every other sheet: formulas still read them.
        try:
            doc.CurrentController.setActiveSheet(sheets.getByName(active))
        except Exception:
            pass
        for n in names:
            if n != active:
                sheets.getByName(n).IsVisible = False
        fitted = _fit_header_footer(doc, sheets.getByName(active))

        doc.storeToURL(out.as_uri(), (_prop("FilterName", "calc_pdf_Export"),))
    except ConversionError:
        raise
    except Exception as err:
        if timed_out.is_set():
            raise ConversionError(f"conversion timed out after {CONVERT_TIMEOUT_S}s") from err
        raise ConversionError(f"{type(err).__name__}: {err}") from err
    finally:
        timer.cancel()
        if doc is not None and not timed_out.is_set():
            try:
                doc.close(True)
            except Exception:
                pass
        if timed_out.is_set():
            _stop_office()

    if not out.exists() or out.stat().st_size == 0:
        raise ConversionError("LibreOffice produced no PDF")

    pages = None
    try:
        from pypdf import PdfReader
        pages = len(PdfReader(str(out)).pages)
    except Exception:
        pass
    if pages == 0:
        raise ConversionError("the printed sheet is empty (0 pages)")

    return {"sheets": names, "printed_sheet": active, "active_from": active_source,
            "fitted": fitted, "pages": pages}


if __name__ == "__main__":
    import sys
    if len(sys.argv) != 3:
        print("usage: python3 convert.py <workbook.xls[x]> <out.pdf>")
        sys.exit(2)
    try:
        print(json.dumps(convert(sys.argv[1], sys.argv[2])))
    finally:
        _stop_office()
