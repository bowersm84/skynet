# skynet-print-copy — setup in the AWS console (no command line)

SkyNet S14 · D-TKIOSK-11a · October 7, 2026

Production cards stay Excel files — that is what Roger uploads and what SkyNet keeps. This AWS Lambda function makes a PDF **print copy** beside each Excel file in the documents bucket (`<file>.xlsx` → `<file>.xlsx.print.pdf`), and the Traveler Kiosk prints the copy. The Excel file is only ever read, never changed.

**What prints:** the sheet that was showing when the workbook was last saved — the sheet Excel prints on Ctrl+P — with its own print area, orientation, margins and fit-to-page, **always on one page**: a sheet that would run longer is shrunk to fit one page. Other sheets are hidden for the copy (not deleted), so formulas that read them still calculate. Macros never run; external links never update. **Tell Roger: save each card with the card's tab showing.**

**Everything below is clicking and pasting in the AWS console.** AWS CodeBuild builds the software image inside AWS, so nothing is installed on your PC. Work in region **US East (N. Virginia) us-east-1** (top-right of the console). Screen labels can drift a little as AWS updates the console; the field names below are what to look for. Allow about an hour, most of it waiting on the build.

**Tested before delivery** (sandbox, LibreOffice 24.2.7 — the same build the image installs): a card whose formula reads a second "data" sheet, with the card not the first tab, as `.xlsx` and `.xls` → only the card printed, one landscape letter page, formula value correct; a 180-row card → one page, every row; uppercase `.XLSX`; a corrupt file → clean "failed"; cards whose footer sits at the bottom margin (like the real Form 10-150 cards) → footer visible, as `.xlsx` and `.xls`; a fixed-scale card that spills one row onto page 2 → one page, every row, frame and footer intact, while cards that already fit come out identical to before; the function against a stand-in bucket for the upload trigger, single cards, the backfill sweep and the review PDF. **Not run here:** CodeBuild and AWS itself — step 5 is the first build and step 9 is the first real card.

---

## Already set up? Update to 1.2 (Oct 8) — five steps

1.2 makes every print copy exactly one page. A card set to a fixed print scale that fills Excel's page with no slack could spill its last row and bottom border onto a second page (J-000203's `223 SK2003-10C1` card). Now, if a copy runs past one page, the card is shrunk to fit one page, as Excel's "Fit Sheet on One Page" does. Cards that already fit are unchanged. (1.1, Oct 7, fixed the hidden `REV 004 … Form 10-150` footer.)

1. **S3** → **skynet-files-skybolt** → `build/` → **Upload** the new `skynet-print-copy.zip` (same name, replaces the old one).
2. **CodeBuild** → **skynet-print-copy-build** → **Start build** → wait for **Succeeded**; the log ends `PUSHED …:1.2`.
3. **Lambda** → **skynet-print-copy** → **Image** tab → **Deploy new image** → **Browse images** → tag `1.2` → **Save**. Wait until the banner says the update finished.
4. **Test** tab → `sweep-count`: `needs_copy` should be every copy on file (about 392), because each was made by an older version. Then run `sweep-run`, and again, until `"remaining": 0` — about 15 minutes in two runs. Each run's `fit_one_page` is how many cards were spilling and are now one page.
5. Reprint J-000203's production card at the kiosk: one page, frame closed, `QMS Form 10-150` at the bottom.

---

## 0. Two checks before you start

1. In the SkyNet project, confirm **both** env files (TEST and PROD) say `VITE_S3_BUCKET=skynet-files-skybolt`. If TEST uses a different bucket, stop and tell Claude.
2. **S3** → **skynet-files-skybolt** → **Properties** tab → scroll to **Event notifications**. It should say there are none. If any are listed, take a screenshot and send it to Claude before going on.

## 1. Put the package in S3

**S3** → **skynet-files-skybolt** → **Create folder** → name it `build` → open it → **Upload** → add `skynet-print-copy.zip` → **Upload**.

(A `.zip` never triggers a conversion; it just sits there for CodeBuild to read.)

## 2. Create the image repository

**Elastic Container Registry (ECR)** → **Private registry → Repositories** → **Create repository**.
- Repository name: `skynet-print-copy`
- Leave everything else as it is → **Create**.

## 3. Create the build project

**CodeBuild** → **Build projects** → **Create build project**.

| Section | Field | Value |
|---|---|---|
| Project configuration | Project name | `skynet-print-copy-build` |
| Source | Source provider | Amazon S3 |
| | Bucket | `skynet-files-skybolt` |
| | S3 object key or S3 folder | `build/skynet-print-copy.zip` |
| Environment | Provisioning model | On-demand |
| | Environment image | Managed image |
| | Compute | EC2 |
| | Operating system | Amazon Linux |
| | Runtime(s) | Standard |
| | Image | the newest `aws/codebuild/amazonlinux-x86_64-standard` (5.0 or later) |
| | **Privileged** | **Tick it** ("Enable this flag if you want to build Docker images") |
| | Service role | New service role (leave the suggested name; note it) |
| Buildspec | Build specifications | Use a buildspec file (leave the name blank) |
| Artifacts | Type | No artifacts |
| Logs | CloudWatch logs | On (the default) |

→ **Create build project**.

## 4. Let the build push its image

**IAM** → **Roles** → open the role CodeBuild just made (named like `codebuild-skynet-print-copy-build-service-role`) → **Add permissions** → **Attach policies** → search `AmazonEC2ContainerRegistryPowerUser` → tick it → **Add permissions**.

## 5. Build the image

**CodeBuild** → **skynet-print-copy-build** → **Start build**. Wait for **Succeeded** (5–15 minutes — it installs LibreOffice). The last lines of the build log say `PUSHED …:1.2`.

If it says **Failed**: open the build → **Build logs** → copy the last 30 lines and send them to Claude.

## 6. Create the function

**Lambda** → **Create function** → **Container image**.
- Function name: `skynet-print-copy`
- Container image URI: **Browse images** → repository `skynet-print-copy` → image tag `1.2` (the newest) → **Select image**
- Architecture: **x86_64**
- Permissions: **Create a new role with basic Lambda permissions**

→ **Create function**.

## 7. Function settings

In the function → **Configuration** tab:
- **General configuration** → **Edit** → Memory `2048` MB · Ephemeral storage `1024` MB · Timeout `15` min `0` sec → **Save**.
- **Environment variables** → **Edit** → **Add environment variable** → Key `BUCKET`, Value `skynet-files-skybolt` → **Save**.

## 8. Function permissions (least privilege)

In the function → **Configuration** → **Permissions** → click the **Role name** (opens IAM) → **Add permissions** → **Create inline policy** → **JSON** → select all the sample text and replace it with the whole contents of `iam-policy.json` from the zip → **Next** → Policy name `skynet-print-copy-s3` → **Create policy**.

That lets the function read the bucket, list it, and write only files ending `.print.pdf` (plus the review PDF in `print-copy-review/`).

## 9. Smoke test on two real cards — REVIEW STOP

In the function → **Test** tab → **Create new event** → Event name `smoke` → replace the Event JSON with:

```json
{"keys": ["jobs/3eb90d40-6ff1-4356-abdc-bc7f53f67bd8/1787757073030_010.1_SK26SW_Stud.xlsx", "jobs/ca3d824b-f9be-4177-9f2d-02eeef836ec8/1785957603740_008_SK26P_Stud_REV2.xls"]}
```

→ **Save** → **Test**. Those are J-000168's card (MZ-5, `.xlsx`) and J-000161's card (MZ-1, `.xls`). The result box should show `"converted": 2`, each card with a `printed_sheet` and `pages`. The first run is slower (LibreOffice starting).

Then **S3** → **skynet-files-skybolt** → `jobs/` → `3eb90d40-6ff1-4356-abdc-bc7f53f67bd8/` → tick the file ending `.print.pdf` → **Download**. Same for `ca3d824b-f9be-4177-9f2d-02eeef836ec8/`. Print both and lay them beside the same cards printed from Excel — including the bottom line, `REV 004 … Form 10-150`.

**Stop here.** Send Claude the result box text and whether the cards match — real cards may have logos, borders or merged cells the test files didn't.

## 10. Switch on automatic conversion

**S3** → **skynet-files-skybolt** → **Properties** → **Event notifications** → **Create event notification**, four times (S3 suffixes are case-sensitive; 11 of today's 189 cards end in uppercase):

| Event name | Suffix | Event types | Destination |
|---|---|---|---|
| print-copy-xlsx | `.xlsx` | All object create events | Lambda function → skynet-print-copy |
| print-copy-xls | `.xls` | All object create events | Lambda function → skynet-print-copy |
| print-copy-XLSX | `.XLSX` | All object create events | Lambda function → skynet-print-copy |
| print-copy-XLS | `.XLS` | All object create events | Lambda function → skynet-print-copy |

Leave **Prefix** empty each time. The console gives S3 permission to call the function. Print copies end in `.print.pdf`, which none of these match, so a copy never triggers another conversion.

## 11. Backfill every existing card

Back in the function's **Test** tab, create two more saved events the same way:

- `sweep-count`: `{"sweep": true, "prefix": "jobs/"}`
- `sweep-run`: `{"sweep": true, "prefix": "jobs/", "dry_run": false}`

Run **sweep-count** first: `needs_copy` is how many Excel files under `jobs/` have no current copy (at least the 189 production cards, plus any other Excel uploads). Then run **sweep-run**, and run it again until the result shows `"remaining": 0`. A run can take several minutes — leave the tab open.

`failed_keys` lists any workbook LibreOffice couldn't convert; send those to Claude. Re-running is safe: it skips every file whose copy is newer than the workbook and was made by the current converter version (so after a converter update, the sweep redoes older copies by itself).

## 12. Check the upload trigger

In SkyNet on **TEST**, upload any `.xlsx` to a test job (WO Lookup → job → Add Document). Then in the function → **Monitor** tab → **View CloudWatch logs** → open the newest log stream. Within about 30 seconds there's a `"converted"` line naming that file.

## 13. Review PDF for Roger

**Test** tab → new event `review`: `{"review": true}` → **Test**. The result names a file under `print-copy-review/`. **S3** → **skynet-files-skybolt** → `print-copy-review/` → tick it → **Download**.

It holds every distinct card once (the same workbook pulled forward onto many jobs is shown once), with a bookmark per card named after its file and the sheet that printed. Roger pages through it against Excel once, and lists any card that doesn't match.

---

**Logs:** function → **Monitor** → **View CloudWatch logs** (one line per conversion: file, printed sheet, pages, seconds, or the error).

**New version later:** each release's zip carries its own tag in `buildspec.yml`. Upload the new zip to the same `build/` spot → CodeBuild → **Start build** → when it succeeds, Lambda → **Image** → **Deploy new image** → **Browse images** → the new tag → **Save** → run `sweep-run` until `remaining` is 0 to redo older copies.

**Turning it off:** delete the four event notifications. Existing print copies are inert files beside the workbooks; only the kiosk reads them.

**Cost:** a few seconds of compute per uploaded workbook, a short build each time the converter changes, and about 1 GB of image storage — negligible at Skybolt's volume. Check the AWS bill after the first month.
