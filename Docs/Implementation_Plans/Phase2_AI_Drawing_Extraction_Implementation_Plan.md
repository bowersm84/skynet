# Phase 2 Implementation Plan — AI Drawing Dimension Extraction
**SkyNet MES · Skybolt Aeromotive Corp · Plan date 2026-07-28 · Author: Matt Bowers w/ Claude**

This document is self-contained. It assumes the reader (a fresh Claude/Claude Code session) has repo access to `bowersm84/skynet` but **no conversation history**. Read `Docs/Decisions.md` before starting any implementation work — especially D-RMF-01.

---

## 1. Background — what exists and why

SkyNet MES is Skybolt's custom manufacturing execution system (React 18 / Vite / Tailwind frontend, Supabase Postgres + RLS + Edge Functions backend, AWS Amplify CI/CD, S3 storage). PROD is `skynet.skybolt.com` (Supabase ref `luzungoqfuplspzbqctb`); TEST is `test-skynet.skybolt.com` (ref `ylzmyjjqibpbqbwjsnqj`). **All migrations run on TEST first with a verification SELECT, then the identical block on PROD.** Skybolt is AS9100D — traceability and human sign-off matter.

### 1.1 The RM Forecast feature (Phase 1, complete — D-RMF-01)

The Armory → Raw Materials area has an **RM Forecast tab** (sibling tab to Inventory Reconciliation; components in `src/components/rmforecast/`) that projects bar-stock and blank-stud consumption from open work orders. It is powered by five Postgres RPCs (all deployed to TEST and PROD, role-gated to admin/scheduler/purchaser via `_rm_forecast_gate()`, `SECURITY DEFINER`, EXECUTE revoked from PUBLIC/anon, granted to authenticated + service_role):

| RPC | Purpose |
|---|---|
| `forecast_rm_bars()` | Weekly bar demand vs on-hand, cumulative runout per material+size |
| `forecast_rm_bar_parts()` | Part-level drill-down rows |
| `forecast_blank_demand()` | Blank-stud demand (pieces, 1:1) by part/dash/week |
| `forecast_blank_onhand()` | Blank stock by series/material/length |
| `forecast_rm_exceptions()` | **Parts in open demand the model cannot price** — the worklist this Phase feeds |

### 1.2 The estimator waterfall

Per part, pieces-per-bar (ppb) resolves in priority order:

1. **Empirical** — actual production history: `SUM(good+bad pieces) / SUM(bars_loaded)` from `jobs` ⨝ `job_materials`. Self-upgrades: the first completed run flips a part from estimate to actuals automatically.
2. **Geometric** — `floor((bar_length − 0.42) / (length_in + 0.149))`. Constants are **kerf+facing 0.149″** and **remnant 0.42″**, least-squares fitted 2026-07-28 against four parts having both drawing lengths and clean history (SK212-12A8, SK-N114-3S, SK213-2B, SK245A161B); all four predict within ±2 % of actuals. Bar length is the modal `job_materials.bar_length` per bar size, defaulting 144″.
3. **Exception** — surfaces in `forecast_rm_exceptions()` and the UI "Needs data" panel.

Geometric inputs come from **`public.part_dimensions`**:

```sql
-- current shape after Phase 1 (already migrated on TEST and PROD)
part_dimensions (
  id uuid PK,
  part_number text NOT NULL UNIQUE,     -- joins parts.part_number (varchar(50) → cast ::text in RPCs)
  length_in numeric,                    -- finished OAL (stud) / height (receptacle) / machined length
  family text,                          -- 'stud' | 'receptacle' | 'receptacle_insert' | 'grommet' | 'component'
  series text,
  source_file text,                     -- catalog file name | 'manual' | (Phase 2 adds 'drawing_ai')
  material_type text,                   -- e.g. '303 Stainless Steel', '6061-T6 Aluminum', '8620 Steel'
  bar_size text,                        -- CANONICAL FORMAT: '0.500 dia' (matches bar_sizes.size)
  created_at timestamptz, updated_at timestamptz
)
-- RLS: SELECT for authenticated; INSERT/UPDATE for admin/scheduler only.
```

~700 rows exist: 639 catalog-seeded (lengths only; material/bar_size NULL — they activate on demand), 11 hand-extracted from drawings with material+size populated. **Canonical `bar_size` string is `X.XXX dia`** — never `0.500"`. `material_type` values must match the `material_types.name` list exactly (these feed string-equality joins against `job_materials` / `material_receiving`).

### 1.3 The exceptions panel (Phase 1 UI — the integration point)

The RM Forecast tab renders a **"Needs data (n)"** amber panel listing `forecast_rm_exceptions()` rows with inline editors: `length_in` (numeric > 0), material (select from `material_types`), bar size (select from `bar_sizes`). Save upserts `part_dimensions` on `part_number` conflict (`source_file='manual'`, `family='component'`) and refreshes all forecast data. Save is admin/scheduler (RLS-enforced); purchaser sees read-only. One Phase 1 nuance to preserve: the editors offer the catalog lists but **store whatever string an existing `part_dimensions` row already uses**, falling back to catalog text — this prevents a save from minting a phantom second material/size group.

### 1.4 Why Phase 2

Roger (compliance officer) uploads part drawings during part creation, and hundreds of never-scheduled components will eventually need dimensions. Phase 1 proved the extraction task is AI-tractable: eleven lengths were read by Claude from PDF drawings (title blocks, dash tables, item tables, pre-crimp notes), two of which cross-validated against empirical production to within 0.002″. It also produced the cautionary tales: two drawings (SK212-24, SK78-420A8S) genuinely admit multiple readings. Hence the governing principle:

> **Suggest, never commit.** AI output pre-fills the existing human editors; a named human confirms every value into `part_dimensions`. No unreviewed AI number ever drives purchasing in an AS9100 shop.

---

## 2. Feature summary

Add an **"Extract from drawing"** action in two places, both feeding the same confirm-to-save path:

1. **Exceptions panel rows** — enabled when the part has a current drawing in `part_documents`. Click → Edge Function reads the drawing → editors pre-fill with the suggestion + provenance ("read Dim A from dash table row SK4C15, confidence high") → user reviews/edits → existing Save upserts with `source_file='drawing_ai'`.
2. **Armory part create/edit modal** — for manufactured/finished_good parts with a drawing-type document attached (uploaded now or previously), a compact "Manufacturing Dimensions" subsection with the same three fields + Extract button + confirm. Saving the part upserts `part_dimensions` the same way.

Backlog strategy stays **demand-driven**: no batch pre-processing in this phase. A part gets dimensions when it enters demand (exceptions panel) or when someone touches it in the Armory. Batch pre-warm of the whole catalog is Phase 3, gated on this phase's confirm-vs-correct ratio.

---

## 3. Architecture

```
[React: exceptions panel / part modal]
        │  supabase.functions.invoke('extract-part-dimensions',
        │      { part_number, document_path | document_base64, description })
        ▼
[Edge Function: extract-part-dimensions]   (Deno, Supabase)
   1. Verify caller JWT; service-role lookup of profiles.role ∈ (admin, scheduler)
   2. Resolve the drawing: download from Supabase Storage / S3 path in part_documents,
      or accept base64 directly from the modal (pre-save uploads)
   3. Service-role fetch of material_types.name[] and bar_sizes.size[] (authoritative lists)
   4. Call Anthropic Messages API (key from Supabase secret ANTHROPIC_API_KEY) with the
      PDF as a document content block + the extraction prompt (§4)
   5. Parse strict-JSON response; validate types/ranges; return suggestion envelope
        ▼
[React] pre-fills editors, renders provenance + confidence chip; Save = existing
part_dimensions upsert path (RLS enforced) + audit_logs event
```

Key properties: the API key never reaches the client; role enforcement happens server-side in the function *and* at save time via RLS; the function is read-only (it writes nothing — the human save does).

### 3.1 Migration (run on TEST → verify → PROD, single block)

```sql
BEGIN;

ALTER TABLE public.part_dimensions
  ADD COLUMN IF NOT EXISTS extraction_meta jsonb,          -- AI suggestion envelope as-confirmed
  ADD COLUMN IF NOT EXISTS confirmed_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

-- Verify
SELECT column_name FROM information_schema.columns
WHERE table_name = 'part_dimensions'
  AND column_name IN ('extraction_meta','confirmed_by','confirmed_at');

COMMIT;
```

On save of an AI-assisted row the client sets: `source_file='drawing_ai'`, `extraction_meta` = the full suggestion envelope (including what the user changed — store both `suggested` and `saved` values), `confirmed_by = auth user id`, `confirmed_at = now()`. Manual (non-AI) saves leave the three new columns NULL. Also insert an `audit_logs` row, `event_type='dimension_ai_confirmed'`, details `{part_number, suggested, saved, edited: bool, confidence}`.

> Environment note: never hard-code profile UUIDs in migrations — TEST and PROD differ (this has bitten before; see D-MACH era notes). `confirmed_by` is set client-side from the session.

### 3.2 Edge Function — reference implementation

Deploy name: `extract-part-dimensions`. Repo convention: commit under `supabase/functions/extract-part-dimensions/index.ts`, then paste-deploy through **both** project dashboards (TEST first). Secrets: `supabase secrets set ANTHROPIC_API_KEY=...` on both projects (dashboard → Edge Functions → Secrets). `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

```ts
// supabase/functions/extract-part-dimensions/index.ts  (reference — adapt, don't paste blind)
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",            // tighten to app origins in PROD if desired
  "Access-Control-Allow-Headers": "authorization, content-type",
};
const MAX_PDF_BYTES = 10 * 1024 * 1024;          // 10 MB cap

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!jwt) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: "Unauthorized" }, 401);
    const { data: prof } = await admin.from("profiles")
      .select("role").eq("id", user.id).single();
    if (!prof || !["admin", "scheduler"].includes(prof.role))
      return json({ error: "Not authorized" }, 403);

    const { part_number, description, document_path, document_base64 } = await req.json();
    if (!part_number || (!document_path && !document_base64))
      return json({ error: "part_number and a document are required" }, 400);

    // 1. Get the PDF bytes
    let pdfB64 = document_base64 as string | undefined;
    if (!pdfB64) {
      // part_documents.file_url convention: resolve bucket/key and download via
      // service role. IMPLEMENTER: read src/ for the exact storage pattern
      // (AddJobDocumentModal / part document upload) rather than assuming.
      const dl = await admin.storage.from("part-documents").download(document_path);
      if (dl.error) return json({ error: "Drawing download failed: " + dl.error.message }, 422);
      const buf = new Uint8Array(await dl.data.arrayBuffer());
      if (buf.byteLength > MAX_PDF_BYTES) return json({ error: "Drawing exceeds 10MB" }, 413);
      pdfB64 = base64Encode(buf);
    }

    // 2. Authoritative vocab for the prompt
    const [{ data: mats }, { data: sizes }] = await Promise.all([
      admin.from("material_types").select("name").order("name"),
      admin.from("bar_sizes").select("size, size_decimal").order("size_decimal"),
    ]);

    // 3. Anthropic call
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: buildSystemPrompt(mats!.map(m => m.name), sizes!.map(s => s.size)),
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfB64 } },
            { type: "text", text: buildUserPrompt(part_number, description) },
          ],
        }],
      }),
    });
    if (!resp.ok) return json({ error: "Extraction service error " + resp.status }, 502);
    const data = await resp.json();
    const text = (data.content ?? []).filter((c: any) => c.type === "text")
      .map((c: any) => c.text).join("\n");
    const suggestion = JSON.parse(text.replace(/```json|```/g, "").trim());

    // 4. Server-side validation before returning
    const errs: string[] = [];
    if (suggestion.length_in != null &&
        (typeof suggestion.length_in !== "number" || suggestion.length_in <= 0 || suggestion.length_in >= 6))
      errs.push("length_in out of range");
    if (suggestion.material_type && !mats!.some(m => m.name === suggestion.material_type))
      { suggestion.material_unlisted = suggestion.material_type; suggestion.material_type = null; }
    if (suggestion.bar_size && !sizes!.some(s => s.size === suggestion.bar_size))
      { suggestion.bar_size_unlisted = suggestion.bar_size; suggestion.bar_size = null; }
    if (errs.length) return json({ error: errs.join("; "), raw: suggestion }, 422);

    return json({ suggestion, model: data.model, usage: data.usage });
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body),
    { status, headers: { ...CORS, "content-type": "application/json" } });
}
```

(`base64Encode`, `buildSystemPrompt`, `buildUserPrompt` are the implementer's to fill; prompt text is §4. The storage-download path is the one part that **must be verified against the repo** — find how `part_documents.file_url` is written at upload time and mirror it.)

### 3.3 Suggestion envelope (function → client)

```json
{
  "suggestion": {
    "length_in": 0.592,
    "material_type": "303 Stainless Steel",
    "bar_size": "0.375 dia",
    "dim_reference": "Dash table sheet 2, row SK4C15, Dim A = 0.592; OD table gives .373-.375 for stainless",
    "confidence": "high",
    "ambiguities": [],
    "drawing_number": "SK4C(X) Cup",
    "revision": "M"
  },
  "model": "claude-sonnet-4-6",
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

`confidence` ∈ `high | medium | low`. Client rule: `low`, non-empty `ambiguities`, or any `*_unlisted` field ⇒ render the amber "review carefully" treatment and do not pre-select the unlisted values.

---

## 4. The extraction prompt (the heart of the feature)

Lessons encoded from the eleven hand-extractions of 2026-07-28 — keep all of them:

**System prompt (template):**

```
You are extracting manufacturing dimensions from a Skybolt Aeromotive engineering
drawing (PDF) so a forecasting system can compute bar-stock yield. Skybolt machines
parts from round bar on CNC lathes. You must return STRICT JSON ONLY — no prose,
no markdown fences.

TARGET PART: the user message names the exact part number. Drawings often cover a
FAMILY with an (xx) or (X) placeholder and a dash-number table — find the row for
the exact part. Example: drawing "SK4C(X) Cup" with a table of SK4C2..SK4C31 →
for SK4C15 read that row's overall-length column (historically "Dim A").

WHAT length_in MEANS: the finished overall machined length of THIS single
component, in inches — the length of bar consumed per piece before parting off.
Rules learned from real Skybolt drawings:
- Cups/formed parts: use the MACHINED length before crimping/forming when the
  drawing distinguishes (e.g. "L* = cup length before crimping").
- Assembly drawings (exploded views, ITEM/QTY tables): the target part is ONE
  item. Use that component's own dimension (e.g. barrel table "Dim A"), never the
  assembled stack height. If only assembled dims exist, say so in ambiguities and
  lower confidence.
- Dash-table columns named L, "L Dim", "Dim A", or total length are the usual
  source; cite exactly which one you used in dim_reference.
- Plate-style parts (platenuts) machined from bar are genuinely ambiguous — if
  you cannot determine the parted-off length, return your best candidate with
  confidence "low" and enumerate the competing readings in ambiguities.

material_type: choose EXACTLY ONE string from this list or null:
{{MATERIAL_TYPES_LIST}}
Map drawing callouts (e.g. "303 Stainless ASTM A582" → "303 Stainless Steel";
"6061-T6"/"6061 Aluminum" → "6061-T6 Aluminum"; "12L14 Steel" → the closest list
entry, else null with the callout quoted in ambiguities). Multi-material part
tables (steel + stainless + aluminum variants of one drawing): pick the row
matching the target part number's suffix conventions (C = 303 stainless,
ZG prefix = aluminum, plain = steel) and note the rule you applied.

bar_size: the bar the part is turned from = the smallest STOCKED size ≥ the
part's maximum OD (largest diameter anywhere on the component, including flange).
Stocked sizes (choose exactly one string or null):
{{BAR_SIZES_LIST}}
Cite the controlling OD in dim_reference.

OUTPUT (all keys required):
{"length_in": number|null, "material_type": string|null, "bar_size": string|null,
 "dim_reference": string, "confidence": "high"|"medium"|"low",
 "ambiguities": string[], "drawing_number": string|null, "revision": string|null}

Return null for anything you cannot determine — never guess silently. A wrong
confident number is far worse than a null: these values drive raw-material
purchasing at an AS9100 aerospace shop, and every suggestion is reviewed by a
human who will check your dim_reference against the drawing.
```

**User message:** the PDF document block plus:

```
Target part number: {{PART_NUMBER}}
SkyNet description: {{DESCRIPTION or "n/a"}}
Extract dimensions for exactly this part.
```

---

## 5. UI integration

### 5.1 Exceptions panel (`src/components/rmforecast/`)

Per row, alongside the Phase 1 editors:

- **Button "Extract from drawing"** — visible admin/scheduler; enabled only when the part has a current drawing (`part_documents` where `is_current` and the document type is the drawing type — **look up `document_types` by name ILIKE '%drawing%' in the repo/DB rather than assuming an id**). Disabled state tooltip: "No drawing on file — upload one in the Armory part editor."
- Click → spinner on the row → `functions.invoke` → on success pre-fill the three editors with suggested values (respecting the Phase 1 store-what-exists string rule), render a provenance line under the row (`dim_reference`, drawing number/rev) and a confidence chip (green/amber/red). `ambiguities[]` render as amber bullets. User may edit anything.
- **Save** uses the existing upsert, extended to write `source_file='drawing_ai'`, `extraction_meta` (envelope + `{suggested, saved}` diff), `confirmed_by`, `confirmed_at`, plus the audit_logs event. If the user cleared all AI values and typed their own, save as plain `'manual'` (no meta).

### 5.2 Armory part modal (`src/pages/Armory.jsx`)

For `part_type` manufactured/finished_good: a compact **Manufacturing Dimensions** subsection (three fields mirroring the panel editors) + the same Extract button, enabled when a drawing document is attached to the part (existing docs, or the one just staged in this modal — pass `document_base64` for not-yet-uploaded files). On part save, if any of the three fields are set, perform the same `part_dimensions` upsert. Pre-load existing `part_dimensions` values into the subsection when editing a part that has a row.

### 5.3 Shared code

One hook/service (`src/components/rmforecast/useDimensionExtraction.js` or `src/lib/dimensionExtraction.js`) owning: invoke, envelope validation, confidence styling map, and the save-payload builder — used by both surfaces. No logic forked between them.

---

## 6. Security, cost, limits

- API key lives only in Supabase Edge Function secrets, set per project (TEST and PROD separately).
- Function validates JWT + role server-side; returns 403 otherwise. RLS still guards the actual write — the function itself writes nothing.
- 10 MB PDF cap; reject non-PDF mime types (Phase 2 scope is PDF drawings only; scanned/raster PDFs are fine — the model reads page images).
- Cost order-of-magnitude: a multi-sheet drawing ≈ a few thousand tokens ≈ ~$0.01–0.05 per extraction at current pricing. No rate limiting needed at Skybolt's volume; log `usage` from each call in the function's console for visibility.
- Timeout: surface a friendly retry on function timeout (~60 s ceiling); typical latency is a few seconds.

## 7. Testing plan — golden set

Ground truth from the 2026-07-28 manual extractions (drawings live at part_documents once Roger attaches them; for testing, upload the same PDFs used in Phase 1):

| Part | Expected length_in | Expected material | Expected bar_size | Expectation notes |
|---|---|---|---|---|
| SK35CS38 | 0.535 | 303 Stainless Steel | 0.375 dia | From spec-sheet L column, dash row 38 |
| SK35CC38 | 0.369 | 303 Stainless Steel | 0.375 dia | Must use pre-crimp L*, not installed height |
| SK4C15C | 0.592 | 303 Stainless Steel | 0.375 dia | Dash-table row SK4C15 Dim A; stainless via C suffix |
| SK215-4BD | 0.470 | 6061-T6 Aluminum | 0.750 dia | Item-table Dim A for the barrel component |
| SK245PM7 | 0.355 | 6061-T6 Aluminum | 0.750 dia | Single-part drawing OAL |
| SK247P | 0.273 | 303 Stainless Steel | 0.125 dia | Simple pin |
| SK213-28B | 0.530 | 6061-T6 Aluminum | 1.000 dia | Assembly drawing; barrel item only |
| SK213A-INS | 0.073 | 6061-T6 Aluminum | 0.375 dia | Thin insert; from assembly dim |
| SK12339738-1 | 1.000 | 8620 Steel | 0.750 dia | Dash table −1 row L Dim |
| SK212-24 | (0.239) | 6061-T6 Aluminum | — | **Must flag ambiguity / low confidence** — competing readings |
| SK78-420A8S | (0.375) | 6061-T6 Aluminum | — | **Must flag ambiguity / low confidence** — platenut geometry |

**Acceptance:** ≥ 9/11 lengths within ±0.005 of expected with correct material; the two ambiguity cases return `confidence: low` with populated `ambiguities` rather than a confident wrong answer. That last criterion is not optional — the feature's trustworthiness rests on it refusing where the humans had to.

UI acceptance (TEST): extraction from an exceptions row pre-fills, provenance renders, save migrates the part into the bar table on refresh with `source_file='drawing_ai'` and populated `extraction_meta`/`confirmed_by`; purchaser role sees no Extract button; part-modal path works with a freshly staged (pre-upload) PDF; drawing-less part shows the disabled tooltip; a forced function error (bad path) surfaces a readable message, not a blank crash.

A formal test-script `.docx` (SkyNet standard format) should be generated from the above before TEST sign-off.

## 8. Deployment order

1. Migration (§3.1): TEST → verify → PROD.
2. `supabase secrets set ANTHROPIC_API_KEY` on TEST project; deploy function to TEST dashboard; curl smoke test with a golden-set PDF.
3. Frontend branch → TEST; run golden set + UI acceptance; record confirm-vs-correct outcomes.
4. Secrets + function deploy on PROD; merge to main (Amplify deploys frontend).
5. Append Decisions entry:

```
### D-RMF-02 — AI drawing dimension extraction (suggest-only) (2026-XX-XX)
**What:** Edge Function extract-part-dimensions (JWT + role gated, service-role
storage read, Anthropic API, strict-JSON envelope with dim_reference/confidence/
ambiguities) feeding pre-filled editors in the RM Forecast exceptions panel and a
Manufacturing Dimensions subsection in the Armory part modal. Human confirm
required; saves carry source_file='drawing_ai', extraction_meta (suggested vs
saved), confirmed_by/at, and an audit_logs event. Golden set: 11 parts from the
Phase 1 manual extractions; acceptance ≥9/11 within ±0.005 and mandatory
ambiguity-flagging on SK212-24 / SK78-420A8S.
**Why:** Backlog of never-run components needs dimensions without a data-entry
project; Phase 1 proved extraction viability and defined the failure modes. AI
suggests, a named human commits — AS9100 posture.
**Files:** supabase/functions/extract-part-dimensions/, src/components/rmforecast/,
src/pages/Armory.jsx, part_dimensions migration (extraction_meta/confirmed_by/at).
```

## 9. Explicit non-goals (Phase 3 candidates)

- Batch pre-processing of the full drawing library (gate on Phase 2's confirm-vs-correct ratio first).
- Auto-commit at any confidence level.
- Non-PDF inputs (DXF/STEP), multi-part BOM explosion, tolerance capture, pieces-per-bar overrides beyond the length model.

## 10. Conventions reminder for the implementing session

- Diagnose before fix: read the actual repo code for storage paths, document types, and modal structure — several assumptions above are deliberately marked for verification.
- TEST before PROD, always; verification SELECT inside every migration; never reuse UUIDs across environments.
- plpgsql `RETURN QUERY` type-matches strictly — any `varchar` column returned as `text` needs `::text` (bit us in Phase 1).
- Edge functions: commit to repo first, then paste-deploy to both dashboards.
- One consolidated CC prompt per round; CRLF line endings; Decisions.md append is the final task inside the CC prompt.
- Response style for Matt: deliverable first, minimal preamble, part numbers on any order-level breakdown.
