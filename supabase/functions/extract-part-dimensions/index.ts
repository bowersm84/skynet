// extract-part-dimensions — AI drawing dimension extraction (D-RMF-05).
//
// Reads a Skybolt engineering drawing (PDF) and returns a SUGGESTION for the
// three values the RM Forecast needs: finished length, material, and the bar
// size the part is turned from. It writes NOTHING to the database — a named
// human confirms every value through the existing part_dimensions upsert. No
// unreviewed AI number reaches purchasing (AS9100).
//
// The PDF arrives base64-encoded from the browser, which already holds AWS
// credentials for the private S3 bucket and resolves the signed URL itself
// (src/lib/dimensionExtraction.js). That keeps AWS credentials out of Supabase
// entirely — this function never touches S3 or Storage.
//
// Deploy: paste into the TEST dashboard first, then PROD. Requires the secret
// ANTHROPIC_API_KEY on each project; SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// are injected automatically.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MODEL = "claude-sonnet-4-6";
const MAX_LENGTH_IN = 6;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

// Decoded byte length of a base64 string, without allocating the buffer.
function base64ByteLength(b64: string): number {
  const clean = b64.replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

// %PDF- magic bytes are "JVBERi0" once base64-encoded from offset 0.
function looksLikePdf(b64: string): boolean {
  return b64.replace(/\s/g, "").startsWith("JVBERi0");
}

function buildSystemPrompt(materials: string[], barSizes: string[]): string {
  return `You are extracting manufacturing dimensions from a Skybolt Aeromotive engineering
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
${materials.join("\n")}
Map drawing callouts (e.g. "303 Stainless ASTM A582" → "303 Stainless Steel";
"6061-T6"/"6061 Aluminum" → "6061-T6 Aluminum"; "12L14 Steel" → the closest list
entry, else null with the callout quoted in ambiguities). Multi-material part
tables (steel + stainless + aluminum variants of one drawing): pick the row
matching the target part number's suffix conventions (C = 303 stainless,
ZG prefix = aluminum, plain = steel) and note the rule you applied.

bar_size: the bar the part is turned from = the smallest STOCKED size ≥ the
part's maximum OD (largest diameter anywhere on the component, including flange).
Stocked sizes (choose exactly one string or null):
${barSizes.join("\n")}
Cite the controlling OD in dim_reference.

OUTPUT (all keys required):
{"length_in": number|null, "material_type": string|null, "bar_size": string|null,
 "dim_reference": string, "confidence": "high"|"medium"|"low",
 "ambiguities": string[], "drawing_number": string|null, "revision": string|null}

Return null for anything you cannot determine — never guess silently. A wrong
confident number is far worse than a null: these values drive raw-material
purchasing at an AS9100 aerospace shop, and every suggestion is reviewed by a
human who will check your dim_reference against the drawing.`;
}

function buildUserPrompt(partNumber: string, description?: string | null): string {
  return `Target part number: ${partNumber}
SkyNet description: ${description || "n/a"}
Extract dimensions for exactly this part.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY is not configured." }, 500);

    const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    const user = userData?.user;
    if (userError || !user) return json({ error: "Unauthorized" }, 401);

    // Mirrors part_dimensions INSERT/UPDATE RLS (D-RMF-07) — only roles that
    // could commit the value are allowed to ask for a suggestion. Multi-role
    // aware: primary role OR the roles[] array (D-MROLE-02).
    const { data: prof } = await admin
      .from("profiles")
      .select("role, roles")
      .eq("id", user.id)
      .single();
    const allowedRoles = ["admin", "scheduler", "purchaser"];
    const userRoles = [prof?.role, ...(prof?.roles ?? [])].filter(Boolean);
    if (!userRoles.some((r) => allowedRoles.includes(r))) {
      return json({ error: "Not authorized" }, 403);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Request body must be JSON." }, 400);
    }

    const partNumber = typeof body.part_number === "string" ? body.part_number.trim() : "";
    const description = typeof body.description === "string" ? body.description : null;
    const fileName = typeof body.file_name === "string" ? body.file_name : null;
    const documentBase64 = typeof body.document_base64 === "string" ? body.document_base64 : "";

    if (!partNumber) return json({ error: "part_number is required." }, 400);
    if (!documentBase64) return json({ error: "document_base64 is required." }, 400);

    const byteLength = base64ByteLength(documentBase64);
    if (byteLength > MAX_PDF_BYTES) {
      return json({ error: "Drawing exceeds the 10 MB limit." }, 413);
    }
    if (!looksLikePdf(documentBase64)) {
      return json({ error: "Only PDF drawings can be read (the file is not a PDF)." }, 415);
    }

    // The catalogs are the authoritative vocabulary — the model may only choose
    // strings that already exist, so a suggestion can never invent a material or
    // size the forecast doesn't group on.
    const [{ data: mats, error: matsError }, { data: sizes, error: sizesError }] =
      await Promise.all([
        admin.from("material_types").select("name").eq("is_active", true).order("name"),
        admin.from("bar_sizes").select("size, size_decimal").eq("is_active", true).order("size_decimal"),
      ]);
    if (matsError || sizesError) {
      return json({ error: "Could not read the material / bar size catalogs." }, 500);
    }

    const materialNames = (mats || []).map((m: { name: string }) => m.name).filter(Boolean);
    const barSizeStrings = (sizes || []).map((s: { size: string }) => s.size).filter(Boolean);
    if (!materialNames.length || !barSizeStrings.length) {
      return json({ error: "The material / bar size catalogs are empty." }, 500);
    }

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system: buildSystemPrompt(materialNames, barSizeStrings),
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                // The API rejects embedded newlines in the base64 payload.
                data: documentBase64.replace(/\s/g, ""),
              },
            },
            { type: "text", text: buildUserPrompt(partNumber, description) },
          ],
        }],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error("Anthropic API error", resp.status, detail.slice(0, 500));
      return json({ error: `Extraction service error ${resp.status}.` }, 502);
    }

    const data = await resp.json();

    // Usage lands in the function log so cost stays visible without a table.
    console.log(JSON.stringify({
      event: "extract-part-dimensions",
      part_number: partNumber,
      file_name: fileName,
      model: data.model,
      usage: data.usage,
      pdf_bytes: byteLength,
    }));

    const text = (data.content ?? [])
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("\n");

    let suggestion: Record<string, unknown>;
    try {
      // Fences are forbidden by the system prompt; strip them anyway rather than
      // fail a good extraction on a formatting slip.
      suggestion = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      console.error("Unparseable extraction response:", text.slice(0, 500));
      return json({ error: "The drawing could not be read into a usable answer." }, 422);
    }

    if (!suggestion || typeof suggestion !== "object") {
      return json({ error: "The drawing could not be read into a usable answer." }, 422);
    }

    if (suggestion.length_in != null) {
      const n = Number(suggestion.length_in);
      if (!Number.isFinite(n) || n <= 0 || n >= MAX_LENGTH_IN) {
        return json({ error: "length_in out of range", raw: suggestion }, 422);
      }
      suggestion.length_in = n;
    } else {
      suggestion.length_in = null;
    }

    // A value outside the catalog is surfaced, never silently substituted — the
    // client shows it as a warning and refuses to pre-select it.
    if (suggestion.material_type && !materialNames.includes(String(suggestion.material_type))) {
      suggestion.material_unlisted = suggestion.material_type;
      suggestion.material_type = null;
    }
    if (suggestion.bar_size && !barSizeStrings.includes(String(suggestion.bar_size))) {
      suggestion.bar_size_unlisted = suggestion.bar_size;
      suggestion.bar_size = null;
    }

    if (!["high", "medium", "low"].includes(String(suggestion.confidence))) {
      suggestion.confidence = "low";
    }
    if (!Array.isArray(suggestion.ambiguities)) {
      suggestion.ambiguities = [];
    }
    if (typeof suggestion.dim_reference !== "string") {
      suggestion.dim_reference = "";
    }

    return json({ suggestion, model: data.model, usage: data.usage });
  } catch (e) {
    console.error("extract-part-dimensions failed:", e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
