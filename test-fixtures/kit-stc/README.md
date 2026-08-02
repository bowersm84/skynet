# Kit & STC intake fixtures

Two fabricated customer STC-paperwork requests for exercising the Log STC
dropzone (`src/lib/emailIntake.js`, D-KSTC-18). Nothing here is real: the
requester, the company domain and the order number are invented, and the claimed
values were chosen to hit the live match hints against TEST data.

| File | Format | Contains |
|---|---|---|
| `sample-request.eml` | RFC-822 multipart | plain-text body + `packing-slip.pdf` attachment |
| `sample-request.msg` | Outlook CFBF | unicode subject/body/sender props, one recipient, same PDF attachment, `clientSubmitTime` |
| `packing-slip.pdf` | PDF | the attachment on its own, for the drop-a-PDF-directly path |

Both messages claim **kit 99000**, **serial 18258371**, **registration N5423K**,
order **S-11417**, from **Irwin International**. Against the TEST registry that
makes the kit chip read `SK203 99000 — Irwin International` and the company chip
match `kit_parties`. The claimed serial deliberately does NOT match the serial on
file for N5423K (`17274105`) — a real discrepancy for the resolution work in
Round C2, and a reminder that claims save as written and are never corrected at
intake.

The `.msg` was burned with msgreader's own CFBF writer (`lib/Burner.js`), so the
fixture is produced by the same package that reads it.

To check both parse, drop them on the New Request dropzone. Expected: the body
text extracts, `packing-slip.pdf` unpacks into its own extraction block, and both
files are listed for attachment — the `.msg`/`.eml` as `request_email`, the PDF
defaulting to `other`.
