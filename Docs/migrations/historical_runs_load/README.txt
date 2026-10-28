D-HIST-01 traveler archive load (2026-10-28). One file per Drive year folder; each is an idempotent
upsert keyed on (source_file, source_seq) and ends with a VERIFY row (rows + fingerprint).
Order: ../2026-10-28_D-HIST-01_historical_runs.sql, then the six load files, then
../2026-10-28_D-HIST-01_resolve.sql. Loaded on TEST and PROD 2026-10-28; fingerprints matched.
Rows: 2021 98, 2022 548, 2023 465, 2024 491, 2025 464, 2026 167 (2,233).
Regenerate from tools/traveler-archive if the archive is re-read.
