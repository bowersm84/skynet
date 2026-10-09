"""
handler.py - skynet-print-copy Lambda (SkyNet S14, D-TKIOSK-11a).

Makes <key>.print.pdf beside every Excel file in the documents bucket, so the
Traveler Kiosk can print production cards while the Excel files stay the files
of record. Three ways in:

  1. S3 trigger (ObjectCreated, suffixes .xls .xlsx .XLS .XLSX): converts the
     uploaded workbook. This is the normal path - Roger uploads, a print copy
     appears a few seconds later.
  2. {"keys": ["jobs/.../card.xlsx", ...]} - converts exactly those keys
     (re-run one card after a fix).
  3. {"sweep": true, "prefix": "jobs/", "dry_run": true} - the backfill. Lists
     the bucket and converts every Excel file whose print copy is missing,
     older than the workbook, or made by an older converter version. Stops with ~60 s to spare and reports
     "remaining"; run it again until remaining is 0. dry_run (default true)
     only counts.
  4. {"review": true, "prefix": "jobs/"} - builds ONE PDF of every distinct
     print copy (duplicates of the same workbook collapsed by source ETag), one
     bookmark per card named after its file and printed sheet, and saves it to
     print-copy-review/review-<UTC time>.pdf for a one-time check against Excel.

The Excel object is only ever read. Output keys always end in .print.pdf,
which the trigger's suffix filters never match, so there is no loop.
"""
import json
import os
import tempfile
import time
import urllib.parse
from pathlib import Path

import boto3
import re
from datetime import datetime, timezone

import convert as converter

BUCKET = os.environ.get("BUCKET", "skynet-files-skybolt")
PRINT_SUFFIX = ".print.pdf"
VERSION = "skynet-print-copy 1.2"   # 1.1: headers/footers no longer clipped; 1.2: always one page
SAFETY_MS = 60_000

s3 = boto3.client("s3")
_office_version = None


def _log(**fields):
    print(json.dumps(fields, default=str))


def _meta(value) -> str:
    # S3 user metadata must be ASCII: percent-encode everything else.
    return urllib.parse.quote(str(value), safe=" ,.;:_-()[]/")


def convert_key(bucket: str, key: str) -> dict:
    global _office_version
    if not converter.is_excel(key):
        return {"key": key, "status": "skipped", "reason": "not an Excel file"}
    if key.endswith(PRINT_SUFFIX):
        return {"key": key, "status": "skipped", "reason": "is a print copy"}
    started = time.time()
    with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
        src = Path(tmp) / ("source" + Path(key).suffix.lower())
        out = Path(tmp) / "print.pdf"
        head = s3.head_object(Bucket=bucket, Key=key)
        s3.download_file(bucket, key, str(src))
        try:
            info = converter.convert(str(src), str(out))
        except converter.ConversionError as err:
            _log(event="convert_failed", key=key, error=str(err))
            return {"key": key, "status": "failed", "error": str(err)}
        if _office_version is None:
            _office_version = converter.office_version()
        s3.upload_file(
            str(out), bucket, key + PRINT_SUFFIX,
            ExtraArgs={
                "ContentType": "application/pdf",
                "Metadata": {
                    "source-etag": head.get("ETag", "").strip('"'),
                    "printed-sheet": _meta(info["printed_sheet"]),
                    "sheets": _meta("; ".join(info["sheets"])),
                    "pages": str(info["pages"] or ""),
                    "fit-one-page": "yes" if info.get("fit_one_page") else "no",
                    "converter": _meta(f"{VERSION} / {_office_version}"),
                },
            },
        )
    result = {
        "key": key, "status": "converted", "print_copy": key + PRINT_SUFFIX,
        "printed_sheet": info["printed_sheet"], "sheets": info["sheets"],
        "pages": info["pages"], "fit_one_page": bool(info.get("fit_one_page")),
        "seconds": round(time.time() - started, 1),
    }
    _log(event="converted", **result)
    return result


def _needs_copy(bucket: str, key: str, modified) -> bool:
    try:
        head = s3.head_object(Bucket=bucket, Key=key + PRINT_SUFFIX)
    except s3.exceptions.ClientError as err:
        if err.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
            return True
        raise
    if head["LastModified"] < modified:
        return True
    made_by = urllib.parse.unquote(head.get("Metadata", {}).get("converter", ""))
    return not made_by.startswith(VERSION)


def _sweep_candidates(bucket: str, prefix: str):
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if converter.is_excel(key) and not key.endswith(PRINT_SUFFIX):
                yield key, obj["LastModified"]


def handler(event, context):
    remaining_ms = (lambda: context.get_remaining_time_in_millis()) if context else (lambda: 10**9)
    results = []

    if isinstance(event, dict) and event.get("Records"):
        for rec in event["Records"]:
            bucket = rec["s3"]["bucket"]["name"]
            key = urllib.parse.unquote_plus(rec["s3"]["object"]["key"])
            results.append(convert_key(bucket, key))
        return {"mode": "trigger", "results": results}

    if isinstance(event, dict) and event.get("keys"):
        bucket = event.get("bucket", BUCKET)
        for key in event["keys"]:
            if remaining_ms() < SAFETY_MS:
                results.append({"key": key, "status": "not_started", "reason": "time budget"})
                continue
            results.append(convert_key(bucket, key))
        return {"mode": "keys", "results": results, **_tally(results)}

    if isinstance(event, dict) and event.get("sweep"):
        bucket = event.get("bucket", BUCKET)
        prefix = event.get("prefix", "")
        dry_run = event.get("dry_run", True) is not False
        todo, up_to_date = [], 0
        for key, modified in _sweep_candidates(bucket, prefix):
            if _needs_copy(bucket, key, modified):
                todo.append(key)
            else:
                up_to_date += 1
        if dry_run:
            return {"mode": "sweep", "dry_run": True, "needs_copy": len(todo),
                    "up_to_date": up_to_date, "sample": todo[:10]}
        done = 0
        for key in todo:
            if remaining_ms() < SAFETY_MS:
                break
            results.append(convert_key(bucket, key))
            done += 1
        return {"mode": "sweep", "dry_run": False, "up_to_date": up_to_date,
                "remaining": len(todo) - done, **_tally(results),
                "failed_keys": [r for r in results if r["status"] == "failed"]}

    if isinstance(event, dict) and event.get("review"):
        return build_review(event.get("bucket", BUCKET), event.get("prefix", "jobs/"), remaining_ms)

    return {"error": "expected an S3 event, {\"keys\": [...]}, {\"sweep\": true} or {\"review\": true}"}


def _card_title(key: str, printed_sheet: str) -> str:
    name = key[: -len(PRINT_SUFFIX)].rsplit("/", 1)[-1]
    name = re.sub(r"^\d{13}_", "", name)               # SkyNet's upload timestamp prefix
    sheet = urllib.parse.unquote(printed_sheet or "")
    return f"{name}  [{sheet}]" if sheet else name


def build_review(bucket: str, prefix: str, remaining_ms) -> dict:
    from pypdf import PdfReader, PdfWriter
    copies = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            if obj["Key"].endswith(PRINT_SUFFIX):
                copies.append(obj["Key"])
    copies.sort(key=lambda k: k.rsplit("/", 1)[-1].lower())
    writer, seen, cards, skipped = PdfWriter(), set(), 0, 0
    with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
        for i, key in enumerate(copies):
            if remaining_ms() < SAFETY_MS:
                return {"mode": "review", "error": "time budget ran out before the review was assembled", "cards": cards}
            head = s3.head_object(Bucket=bucket, Key=key)
            meta = head.get("Metadata", {})
            ident = meta.get("source-etag") or key
            if ident in seen:
                skipped += 1
                continue
            seen.add(ident)
            local = Path(tmp) / f"{i}.pdf"
            s3.download_file(bucket, key, str(local))
            writer.append(PdfReader(str(local)), outline_item=_card_title(key, meta.get("printed-sheet")), import_outline=False)
            cards += 1
        out = Path(tmp) / "review.pdf"
        with open(out, "wb") as fh:
            writer.write(fh)
        review_key = "print-copy-review/review-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + ".pdf"
        s3.upload_file(str(out), bucket, review_key, ExtraArgs={"ContentType": "application/pdf"})
    result = {"mode": "review", "review_pdf": review_key, "cards": cards,
              "pages": len(writer.pages), "duplicates_collapsed": skipped}
    _log(event="review_built", **result)
    return result


def _tally(results):
    out = {"converted": 0, "failed": 0, "skipped": 0, "fit_one_page": 0}
    for r in results:
        if r["status"] in out:
            out[r["status"]] += 1
        if r.get("fit_one_page"):
            out["fit_one_page"] += 1
    return out
