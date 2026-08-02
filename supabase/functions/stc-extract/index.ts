// stc-extract — AI field extraction from a customer STC-paperwork request
// (D-KSTC-18), following the drawing-extraction precedent (D-RMF-05).
//
// SUGGEST, NEVER COMMIT. This function reads whatever the customer sent — the
// email body, its PDF/image attachments, a scanned form — and returns FIELD
// SUGGESTIONS. It writes nothing. A human reviews every value in an editable
// form and presses Save, and the saved human is the author of record. If this
// function is down, misconfigured, or returns nonsense, the intake form still
// works: it is simply blank.
//
// The blocks arrive already parsed and base64-encoded from the browser
// (src/lib/emailIntake.js unpacks .msg / .eml client-side), so this function
// never touches S3, Storage, or the database.
//
// Deploy: supabase functions deploy stc-extract (TEST first, then PROD).
// Requires the secret ANTHROPIC_API_KEY on each project; SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Everything the customer sent, decoded, must fit under this. Generous enough
// for a scanned multi-page 337 plus photos; small enough that a runaway upload
// fails here with a sentence rather than timing out downstream.
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1500;

const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

// Every key the client may pre-fill from. Anything else the model invents is
// dropped — the form has no slot for it.
const STRING_FIELDS = [
  "received_date",
  "requester_name",
  "requester_company",
  "requester_email",
  "claimed_kit_number",
  "claimed_kit_part",
  "claimed_aircraft_serial",
  "claimed_registration",
  "claimed_order_number",
  "purchased_from",
  "summary",
];

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

const SYSTEM_PROMPT = `You are extracting fields from a customer's STC-paperwork request — an email,
and sometimes its attachments — for Skybolt Aeromotive's aerospace fastener kit
registry. Skybolt sells serialized quick-release fastener kits; customers write
in asking for the STC paperwork covering a kit they bought and installed on an
aircraft. Your job is to read what they wrote and hand a human the fields,
already filled in, so they only have to check them.

Return STRICT JSON ONLY — no prose, no markdown fences, no commentary.

SCHEMA (every key required):
{"received_date": "YYYY-MM-DD"|null,
 "requester_name": string|null,
 "requester_company": string|null,
 "requester_email": string|null,
 "claimed_kit_number": string|null,
 "claimed_kit_part": string|null,
 "claimed_aircraft_serial": string|null,
 "claimed_registration": string|null,
 "claimed_order_number": string|null,
 "purchased_from": string|null,
 "summary": string,
 "confidence": {"<field name>": "high"|"medium"|"low"}}

THE ONE RULE THAT MATTERS: transcribe EXACTLY AS WRITTEN. Never guess, never
normalize, never tidy, never expand an abbreviation, never fix what looks like a
typo, never add or strip prefixes, dashes, spaces, or leading zeros. These are
CLAIMS — the registry stores them verbatim and a human resolves them later
against the real records. A kit number may be nonsense, out of range, or
obviously a different company's part number: keep it verbatim anyway. If a value
is not present, return null. A null is always better than a guess.

FIELD NOTES:
- received_date: the date the customer's message was SENT/received, from the
  email headers or the letter. Format YYYY-MM-DD. Null if there is no date.
- requester_name / requester_company / requester_email: who is asking. The
  company is the shop, FBO, or operator; null if they only signed a personal
  name. Take the email address verbatim.
- claimed_kit_number: the kit / lot / serial number the customer cites for the
  Skybolt kit itself (often a bare 4-6 digit number like 99000). Verbatim.
- claimed_kit_part: the kit part number or kit name they cite (e.g. "SK203-1",
  "Cessna 182 conversion kit"). Verbatim.
- claimed_aircraft_serial: the AIRFRAME SERIAL NUMBER — the manufacturer's
  serial for the airplane (e.g. "18258371", "172S-9021", "TC-1234").
- claimed_registration: the REGISTRATION — the tail marking painted on the
  aircraft. Usually N-prefixed in the US ("N5423K"), but registrations abroad
  carry other prefixes: C- (Canada), VH- (Australia), ZK- (New Zealand),
  TF- (Iceland), G- (UK), D- (Germany), F- (France), PT-/PR- (Brazil), and many
  more. DO NOT SWAP THESE TWO FIELDS. If the customer labels them, believe the
  label. If they give one unlabelled value, judge it on its shape and mark the
  confidence accordingly — a registration-shaped token goes in registration.
- claimed_order_number: the Skybolt order / sales-order / SO / invoice reference
  the customer cites, if any. Verbatim, including any S- prefix as written.
- purchased_from: who they say they bought the kit from — Skybolt directly, a
  distributor, a dealer, or the previous aircraft owner. Their words.
- summary: ONE sentence describing what this request is for. Always a string,
  never null.
- confidence: one entry per NON-NULL field above (excluding summary), keyed by
  the exact field name. "high" = stated plainly and unambiguously labelled;
  "medium" = present but inferred from context or position; "low" = you are
  reading between the lines, or the value could belong in another field.

Everything you return is a suggestion shown to a human who has the original
email open beside it. Be accurate, be literal, and leave blank what is not
there.`;

const USER_INSTRUCTION =
  "The customer's request is above. Extract the fields as specified, exactly as written. Return only the JSON object.";

type Block =
  | { type: "text"; name?: string; text: string }
  | { type: "document"; name?: string; media_type: string; data: string }
  | { type: "image"; name?: string; media_type: string; data: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return fail("Method not allowed", 405);

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return fail("ANTHROPIC_API_KEY is not configured.", 500);

    // Platform JWT verification is on (the default), so a request without a
    // valid token never reaches here. This re-check makes the boundary explicit
    // and survives a config slip. No role gate: extraction reads nothing and
    // writes nothing, and stc_create_request + RLS govern what may be saved.
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

    const blocks = Array.isArray(body.blocks) ? (body.blocks as Block[]) : null;
    if (!blocks || blocks.length === 0) {
      return fail("blocks is required and must be a non-empty array.", 400);
    }

    // Size is checked across the WHOLE payload before anything is forwarded —
    // a caller cannot slip past by splitting one big file into many blocks.
    let totalBytes = 0;
    const content: Record<string, unknown>[] = [];

    for (const [i, block] of blocks.entries()) {
      const label = typeof block?.name === "string" && block.name.trim()
        ? block.name.trim()
        : `attachment ${i + 1}`;

      if (block?.type === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (!text.trim()) continue;
        totalBytes += new TextEncoder().encode(text).length;
        content.push({ type: "text", text: `--- ${label} ---\n${text}` });
        continue;
      }

      if (block?.type === "document" || block?.type === "image") {
        const data = typeof block.data === "string" ? block.data.replace(/\s/g, "") : "";
        if (!data) return fail(`"${label}" carries no file data.`, 400);
        totalBytes += base64ByteLength(data);

        if (block.type === "document") {
          if (block.media_type !== "application/pdf") {
            return fail(`"${label}" is not a PDF — document blocks must be application/pdf.`, 415);
          }
          // Name the file first so the model can attribute what it reads.
          content.push({ type: "text", text: `--- attachment: ${label} ---` });
          content.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data },
          });
        } else {
          if (!IMAGE_MEDIA_TYPES.includes(String(block.media_type))) {
            return fail(
              `"${label}" is not a readable image type (${block.media_type || "unknown"}).`,
              415,
            );
          }
          content.push({ type: "text", text: `--- attachment: ${label} ---` });
          content.push({
            type: "image",
            source: { type: "base64", media_type: block.media_type, data },
          });
        }
        continue;
      }

      return fail(`Block ${i + 1} has an unknown type.`, 400);
    }

    if (totalBytes > MAX_TOTAL_BYTES) {
      const mb = (totalBytes / 1048576).toFixed(1);
      return fail(
        `The uploaded files total ${mb} MB — the 20 MB limit for one request is exceeded. Attach the largest files to the saved intake instead of sending them for extraction.`,
        413,
      );
    }
    if (!content.length) return fail("Nothing readable was supplied.", 400);

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
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error("Anthropic API error", resp.status, detail.slice(0, 500));
      return fail(`Extraction service error ${resp.status}.`, 502);
    }

    const data = await resp.json();

    // Usage lands in the function log so cost stays visible without a table.
    console.log(JSON.stringify({
      event: "stc-extract",
      blocks: blocks.length,
      total_bytes: totalBytes,
      model: data.model,
      usage: data.usage,
    }));

    const text = (data.content ?? [])
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

    // Shape the envelope so the form can trust it: every key present, strings
    // or null, confidence limited to the three known levels. Values themselves
    // are passed through UNTOUCHED — normalizing a claim here would defeat the
    // as-written discipline the whole registry runs on (D-KSTC-07).
    const fields: Record<string, unknown> = {};
    for (const key of STRING_FIELDS) {
      const v = parsed[key];
      fields[key] = typeof v === "string" && v.trim() ? v : null;
    }
    if (fields.summary == null) fields.summary = "";

    const rawConfidence = (parsed.confidence && typeof parsed.confidence === "object")
      ? parsed.confidence as Record<string, unknown>
      : {};
    const confidence: Record<string, string> = {};
    for (const key of STRING_FIELDS) {
      if (key === "summary" || fields[key] == null) continue;
      const level = String(rawConfidence[key] ?? "");
      confidence[key] = ["high", "medium", "low"].includes(level) ? level : "low";
    }
    fields.confidence = confidence;

    return json({ ok: true, fields, model: data.model, usage: data.usage });
  } catch (e) {
    console.error("stc-extract failed:", e);
    return fail(String((e as Error)?.message ?? e), 500);
  }
});
