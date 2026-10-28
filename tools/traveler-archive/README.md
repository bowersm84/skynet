# traveler-archive

Reads the Form 10-100 Work Travelers (Oct 2021 - May 2026) from Google Drive for desktop and writes
runs.csv / ops.csv / exceptions.csv / skipped.csv. D-HIST-01.

    py -m pip install openpyxl xlrd pandas
    py traveler_extract.py "G:\My Drive\Skybolt\SkyNet\003 Travelers and Passivation Logs\01 New Work Order - Post 10-1-2021\Travelers-Post-10-1-21" traveler_out

Only spreadsheets are opened; numbered quality forms and drawings are skipped by name, travelers named
"<order>   <part>_traveler.xlsx" (late 2023 on) are always opened. --from <skipped.csv> reprocesses
just the files an earlier run skipped. Shop shorthand (M2, N4, NT1, BM2, B3, G) maps to SkyNet machine
names; an unnumbered "Mazak" stays "Mazak ?". The CSVs were turned into the SQL load files in
Docs/migrations/historical_runs_load/ (rows keyed on source_file).
