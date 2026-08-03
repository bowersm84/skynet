// packing-slip-extract — AI line extraction from a Fishbowl packing slip
// (D-KSTC-28), following stc-extract's structure exactly (D-KSTC-18).
//
// SUGGEST, NEVER COMMIT. This function reads the slip the warehouse just
// printed and returns the component lines it can see. It writes nothing. The
// operator confirms every part number, lot number and quantity in an editable
// grid, and kit_record_component_lots writes THAT — never this output. If this
// function is down or returns nonsense, nothing is lost: the shipping-report
// backfill loader still sweeps the same ground periodically (D-KSTC-25).
//
// The file arrives already base64-encoded from the browser, so this function
// never touches S3, Storage, or the database.
//
// Deploy: npx supabase functions deploy packing-slip-extract (TEST first, PROD
// at promotion). Requires the secret ANTHROPIC_API_KEY on each project;
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// One slip, decoded. A long multi-page shipment still lands well inside this;
// anything larger is a scan setting problem and fails here with a sentence.
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MODEL = "claude-sonnet-4-6";
// A 25-line slip returns ~3k tokens of JSON. Large multi-kit shipments run
// several times that, and a truncated line table is worse than none.
const MAX_TOKENS = 8000;

const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function fail(error: string, status: number) {
  return json({ ok: false, error }, status);
}

// Decoded byte length of a base64 string, without allocating the buffer.
function base64ByteLength(b64: string): number {
  const clean = b64.replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

const SYSTEM_PROMPT =
  `You are reading a Fishbowl PACKING SLIP for Skybolt Aeromotive, an aerospace
fastener manufacturer. Skybolt ships serialized quick-release fastener KITS; each
kit is built from components that each carry their own manufacturing LOT NUMBER.
The packing slip is the only document that records which component lots went into
which shipment, and that record is an FAA traceability obligation. Your job is to
transcribe those lines so a warehouse operator can confirm them on screen.

Return STRICT JSON ONLY — no prose, no markdown fences, no commentary.

ANATOMY OF THE SLIP:

- HEADER: the top of every page carries "Packing Slip", a Date, and an
  "Order #" like "S16373". The order number is the Sales Order; STRIP the
  leading "S" and return the digits only ("16373").
- ship_date: the packing slip's own header Date (top of the page, beside
  "Date"). Format YYYY-MM-DD. Do NOT use "Date Scheduled" from the shipping
  block lower down, and do not use the printed-on timestamp in the page footer.
- NOTES: a "Notes:" area near the addresses sometimes carries a hint of the form
  "<KIT PART NUMBER>      Lot: <number>" — e.g. "SK203C172P4      Lot: 99942".
  That is the kit's own SKU and the kit lot number the warehouse assigned.
  Return it as notes_hint. If there is no such note, return null.
- LINE TABLE (may run over several pages, with the column header repeated):
  Line # | Part # | Description | Qty Ordered | Qty Shipped | Qty Remaining

THE STRUCTURE THAT MATTERS — HEADER LINES vs COMPONENT LINES:

The table is two levels deep, and indentation is the only thing separating them.

- A KIT / TOOL-SET HEADER LINE carries a part number and a description but NO
  "Lot#:" and no quantities — e.g.
      1 SK203C172P4 SK40S5S Phillips - Complete Kit
      23 SK4P3-T26 SK-4P3 Pliers and SK-T26 Tools Set
  These are the things being sold. They are NOT components and get NO line of
  their own in the output — each becomes a GROUP.
- A COMPONENT LINE sits beneath a header line, is indented, and its description
  ends with a quantity-and-lot phrase "N ea - Lot#: X" — e.g.
      4      SK40S5-2S Phillips Stud - Stainless - 1050 LB - Diamondhead
             26 ea - Lot#: 8071    26 ea   26 ea   ea   0
  Every component line belongs to the nearest header line ABOVE it. A slip with
  two header lines therefore produces two groups, and the second group's
  components are only those following it.

For each component line return:
  line_no        the Line # column, as an integer
  part_number    the Part # column
  qty_shipped    the quantity from the "N ea - Lot#: X" phrase, as a number
  lot_number     the value after "Lot#:", or null if this line genuinely has
                 none printed / it is illegible. Return the line either way —
                 the operator sees it flagged and can read it off the paper.
                 Never invent a lot number to fill the field.
  confidence     "high" | "medium" | "low"

If a component line has no header line above it (the slip starts mid-table, the
grouping is unreadable, or a line genuinely stands alone), put it in
ungrouped_lines instead of inventing a parent. Never guess a parent.

TRANSCRIBE VERBATIM. Part numbers and lot numbers are copied EXACTLY as printed —
never normalized, never corrected, never tidied. Do not change case, do not add or
strip dashes, spaces, prefixes or leading zeros, do not fix what looks like a
typo, do not expand an abbreviation. A lot number of "0001" is "0001", not "1".
These strings are the traceability record and the registry stores them as
written; a human checks them against the paper on screen.
ONE READING EXCEPTION, because it is reading rather than correcting: a part
number that WRAPS across two lines inside its column is still one token — join it
with no space ("MS20426AD4-" + "5C" is "MS20426AD4-5C"). The wrap is the page
layout, not part of the number.

CONFIDENCE, per component line: "high" = part number, quantity and lot all print
cleanly and unambiguously; "medium" = legible but something needed judgement
(a wrap, a smudge, an unusual format); "low" = you are reading between the lines
and the operator should check this one carefully.

SCHEMA (every key required):
{"order_number": string|null,
 "ship_date": "YYYY-MM-DD"|null,
 "notes_hint": {"kit_sku": string, "kit_lot_number": string}|null,
 "groups": [{"parent_part_number": string,
             "lines": [{"line_no": number|null, "part_number": string,
                        "qty_shipped": number|null, "lot_number": string|null,
                        "confidence": "high"|"medium"|"low"}]}],
 "ungrouped_lines": [{"line_no": number|null, "part_number": string,
                      "qty_shipped": number|null, "lot_number": string|null,
                      "confidence": "high"|"medium"|"low"}],
 "overall_confidence": "high"|"medium"|"low"}

Read every page. Miss nothing, invent nothing, and return null where a value is
genuinely not on the document.`;

const USER_INSTRUCTION =
  "The packing slip is above. Extract the order number, ship date, notes hint, and every component line grouped under its kit header line, exactly as printed. Return only the JSON object.";

type Line = {
  line_no: unknown;
  part_number: unknown;
  qty_shipped: unknown;
  lot_number: unknown;
  confidence: unknown;
};

const LEVELS = ["high", "medium", "low"];

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function level(v: unknown): string {
  const s = String(v ?? "");
  return LEVELS.includes(s) ? s : "low";
}

// A line needs a part number to be a line at all. A MISSING lot number is kept
// and passed through as null rather than dropped: the review grid shows it as
// excluded, and the operator can read the lot off the paper and type it in.
// Silently swallowing a component would be the one failure nobody could see.
function shapeLine(raw: unknown) {
  const l = (raw ?? {}) as Line;
  const part = str(l.part_number);
  if (!part) return null;
  return {
    line_no: num(l.line_no),
    part_number: part,
    qty_shipped: num(l.qty_shipped),
    lot_number: str(l.lot_number),
    confidence: level(l.confidence),
  };
}

function shapeLines(raw: unknown) {
  return (Array.isArray(raw) ? raw : []).map(shapeLine).filter(Boolean);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return fail("Method not allowed", 405);

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return fail("ANTHROPIC_API_KEY is not configured.", 500);

    // Platform JWT verification is on (the default), so a request without a
    // valid token never reaches here. This re-check makes the boundary explicit
    // and survives a config slip. No role gate: extraction reads nothing and
    // writes nothing, and kit_record_component_lots governs what may be saved.
    // The bench station's kiosk JWT is a valid token, which is the point.
    const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return fail("Unauthorized", 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return fail("Unauthorized", 401);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return fail("Request body must be JSON.", 400);
    }

    const data64 = typeof body.file_base64 === "string"
      ? body.file_base64.replace(/\s/g, "")
      : "";
    const mediaType = String(body.media_type ?? "");
    if (!data64) return fail("file_base64 is required.", 400);
    if (!mediaType) return fail("media_type is required.", 400);

    const totalBytes = base64ByteLength(data64);
    if (totalBytes > MAX_TOTAL_BYTES) {
      const mb = (totalBytes / 1048576).toFixed(1);
      return fail(
        `That slip is ${mb} MB — the 20 MB limit for one request is exceeded. Scan it at a lower resolution, or upload the PDF rather than a photo.`,
        413,
      );
    }

    const content: Record<string, unknown>[] = [];
    if (mediaType === "application/pdf") {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: data64 },
      });
    } else if (IMAGE_MEDIA_TYPES.includes(mediaType)) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: data64 },
      });
    } else {
      return fail(
        `${mediaType} is not a readable packing slip — upload a PDF or a photo (PNG, JPEG, WebP).`,
        415,
      );
    }
    content.push({ type: "text", text: USER_INSTRUCTION });

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // Transcription, not composition — there is one right answer on the page.
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error("Anthropic API error", resp.status, detail.slice(0, 500));
      return fail(`Extraction service error ${resp.status}.`, 502);
    }

    const result = await resp.json();

    // Usage lands in the function log so cost stays visible without a table.
    console.log(JSON.stringify({
      event: "packing-slip-extract",
      media_type: mediaType,
      total_bytes: totalBytes,
      model: result.model,
      usage: result.usage,
    }));

    const text = (result.content ?? [])
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("\n");

    let parsed: Record<string, unknown>;
    try {
      // Fences are forbidden by the system prompt; strip them anyway rather
      // than fail a good extraction on a formatting slip.
      parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      console.error("Unparseable extraction response:", text.slice(0, 1000));
      // The raw text rides back in `error` on purpose — this is the only way to
      // debug a bad extraction, and the client shows a generic line either way.
      return json({ ok: false, error: `Unparseable response: ${text.slice(0, 2000)}` }, 422);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ ok: false, error: `Response was not a JSON object: ${text.slice(0, 2000)}` }, 422);
    }

    // Shape the envelope so the review grid can trust it: every key present,
    // types coerced, confidence limited to the three known levels. The VALUES
    // are passed through untouched — normalizing a part or lot number here
    // would defeat the as-written discipline the registry runs on (D-KSTC-24).
    const rawHint = (parsed.notes_hint && typeof parsed.notes_hint === "object")
      ? parsed.notes_hint as Record<string, unknown>
      : null;
    const hintSku = rawHint ? str(rawHint.kit_sku) : null;
    const hintLot = rawHint ? str(rawHint.kit_lot_number) : null;

    const groups = (Array.isArray(parsed.groups) ? parsed.groups : [])
      .map((g: unknown) => {
        const group = (g ?? {}) as Record<string, unknown>;
        const parent = str(group.parent_part_number);
        if (!parent) return null;
        return { parent_part_number: parent, lines: shapeLines(group.lines) };
      })
      .filter(Boolean);

    return json({
      ok: true,
      slip: {
        order_number: str(parsed.order_number),
        ship_date: str(parsed.ship_date),
        notes_hint: (hintSku || hintLot)
          ? { kit_sku: hintSku, kit_lot_number: hintLot }
          : null,
        groups,
        ungrouped_lines: shapeLines(parsed.ungrouped_lines),
        overall_confidence: level(parsed.overall_confidence),
      },
      model: result.model,
      usage: result.usage,
    });
  } catch (e) {
    console.error("packing-slip-extract failed:", e);
    return fail(String((e as Error)?.message ?? e), 500);
  }
});
