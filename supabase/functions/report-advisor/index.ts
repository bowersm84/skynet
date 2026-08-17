// supabase/functions/report-advisor/index.ts
// Uncle Bob — Reports Advisor (D-RPT-06). Reads one report's summarized
// envelope and returns a plain-English reading. Writes nothing: the calling
// client owns all report_ai_runs inserts, exactly as the schedule advisor does.
//
// Streams SSE with heartbeats for the same reason schedule-advisor does
// (D-AISCHED-07): Fable 5 with high effort thinks well past the ~200s gateway
// reap, and a buffered response dies mid-flight. Structure — auth, CORS, SSE
// framing, heartbeat, error shapes — mirrors schedule-advisor deliberately.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = "claude-fable-5";
const MAX_TOKENS = 4000;
// Fable 5 (Mythos-class) controls thinking via adaptive + effort, not a token
// budget (D-AISCHED-08).
const THINKING_EFFORT = "high";
const MAX_ENVELOPE_BYTES = 1_000_000;
const HEARTBEAT_MS = 10_000;
// D-RPT-06: narrower than report view access — the same three roles that may
// export. Multi-role aware (role OR roles[]) per D-MROLE-02.
const ALLOWED_ROLES = ["admin", "president", "scheduler"];

const SYSTEM_PROMPT =
  `You are Uncle Bob, the AI advisor inside SkyNet — the manufacturing execution system at Skybolt Aeromotive Corp, an AS9100D aerospace fastener manufacturer in Leesburg and Tavares, Florida.

You are reading one report and explaining what it means to the person who just ran it. Your audience is an experienced manufacturing professional who knows the shop far better than you do. They do not need the report explained back to them; they need what a sharp analyst would notice on a careful read.

CONTEXT YOU MUST HOLD:

- SkyNet tracks MANUFACTURED demand. Parts Skybolt buys rather than makes never get a work order and therefore never appear in these reports. A part absent from SkyNet is usually a bought part, NOT a data-entry failure. Never characterize SkyNet's coverage of the sales backlog as a gap, a problem, or a data-quality issue — that interpretation lives downstream and is already being handled. This is the single most important thing to get right.
- Part-number-first is the shop standard. Whenever you reference a line, an order, or a customer position, lead with the part number.
- 'pending_compliance' is the NORMAL pre-scheduling state, not a problem. Scheduling precedes compliance review by design.
- A line with no active work order is not automatically a problem — it may be too far out to schedule, or a bought part. Say what you see; do not assume neglect.

RULES:

1. Ground every statement in the data you were given. Cite specific part numbers, CO numbers, customers, and figures. If you cannot point at a number, do not say it.
2. You receive AGGREGATES plus a bounded SAMPLE of rows, not the full result set. Never state or imply a fact about rows you cannot see. When something would require the full set to confirm, say so plainly and put it in data_gaps.
3. No recommendations to change the data, the schedule, or the system. You are reading, not directing. Observations may note what is worth a human look; they may not issue instructions.
4. Plain language. No consultant vocabulary, no hedging padding, no restating the obvious.
5. If the data genuinely shows nothing remarkable, say that. A short honest reading beats a padded one. Manufacturing a concern to appear useful is the worst failure available to you.

Respond with ONLY a JSON object, no preamble and no markdown fences:

{
  "reading": "2-4 sentences. What this report says right now, in plain English. This is the headline.",
  "observations": [
    {"text": "One specific, data-grounded observation.", "evidence": "The figures or identifiers behind it.", "confidence": "high|medium|low"}
  ],
  "watch_items": ["Short phrases naming things a human may want to look at. Omit or leave empty if nothing qualifies."],
  "data_gaps": ["Things you could not determine from what you were given. Empty array if none."]
}

Aim for 2 to 5 observations. Fewer honest observations beat more padded ones.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    // ── Auth: JWT → user → multi-role check (role OR roles[]) ─────────────
    // Fast-path failures stay plain JSON; the client surfaces them from its
    // !resp.ok branch.
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Missing Authorization header" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return json({ error: "Invalid session — sign in again." }, 401);
    }

    const { data: prof, error: profErr } = await admin
      .from("profiles")
      .select("role, roles, is_active")
      .eq("id", userData.user.id)
      .single();
    if (profErr || !prof || prof.is_active === false) {
      return json({ error: "Profile not found or inactive" }, 403);
    }
    const effectiveRoles = [prof.role, ...(prof.roles || [])].filter(Boolean);
    if (!effectiveRoles.some((r: string) => ALLOWED_ROLES.includes(r))) {
      return json(
        { error: "report-advisor requires admin, president, or scheduler" },
        403,
      );
    }

    // ── Reject before spend ───────────────────────────────────────────────
    const body = await req.json().catch(() => null);
    const envelope = body?.envelope;
    if (!envelope || typeof envelope !== "object") {
      return json({ error: "Missing envelope" }, 400);
    }
    const serialized = JSON.stringify(envelope);
    if (serialized.length > MAX_ENVELOPE_BYTES) {
      return json({
        error:
          `Envelope too large (${serialized.length} bytes; limit ${MAX_ENVELOPE_BYTES})`,
      }, 400);
    }
    if (!envelope.row_count) {
      // Nothing to read. Fast-path plain JSON, same shape the stream returns.
      return json({
        model: MODEL,
        envelope: {
          reading:
            "This report returned no rows, so there is nothing to read.",
          observations: [],
          watch_items: [],
          data_gaps: [],
        },
        usage: null,
      });
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);

    // ── Stream: heartbeats while Anthropic generates, then one result ─────
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let open = true;
        const send = (event: string, data: unknown) => {
          if (!open) return;
          try {
            controller.enqueue(
              encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          } catch (_e) { open = false; }
        };
        const ping = setInterval(() => {
          if (!open) return;
          try { controller.enqueue(encoder.encode(`: ping\n\n`)); }
          catch (_e) { open = false; }
        }, HEARTBEAT_MS);

        try {
          const resp = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: MODEL,
              max_tokens: MAX_TOKENS,
              thinking: { type: "adaptive" },
              output_config: { effort: THINKING_EFFORT },
              system: SYSTEM_PROMPT,
              messages: [{ role: "user", content: serialized }],
              stream: true,
            }),
          });

          if (!resp.ok || !resp.body) {
            const detail = await resp.text().catch(() => "");
            send("error", {
              error: `Anthropic API ${resp.status}: ${detail.slice(0, 400)}`,
            });
            return;
          }

          // Parse Anthropic's SSE: accumulate text deltas (skip thinking),
          // merge usage from message_start (input) + message_delta (output).
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          let text = "";
          let usage: Record<string, unknown> | null = null;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const frames = buf.split("\n\n");
            buf = frames.pop() ?? "";
            for (const frame of frames) {
              const dataLine = frame.split("\n").find((l) =>
                l.startsWith("data: ")
              );
              if (!dataLine) continue;
              let payload: Record<string, unknown>;
              try { payload = JSON.parse(dataLine.slice(6)); } catch { continue; }
              const type = payload.type as string;
              if (type === "error") {
                const err = payload.error as Record<string, unknown> | undefined;
                send("error", {
                  error: `Anthropic stream error: ${err?.message ?? "unknown"}`,
                });
                return;
              }
              if (type === "message_start") {
                const u = (payload.message as Record<string, unknown> | undefined)
                  ?.usage;
                if (u) usage = { ...(usage || {}), ...(u as Record<string, unknown>) };
              }
              if (type === "message_delta" && payload.usage) {
                usage = {
                  ...(usage || {}),
                  ...(payload.usage as Record<string, unknown>),
                };
              }
              if (type === "content_block_delta") {
                const delta = payload.delta as Record<string, unknown> | undefined;
                if (delta?.type === "text_delta") text += delta.text as string;
              }
            }
          }

          const cleaned = text.replace(/```json|```/g, "").trim();
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(cleaned);
          } catch {
            send("error", {
              error: "Uncle Bob returned unparseable output. Try again.",
              raw: cleaned.slice(0, 800),
            });
            return;
          }

          send("result", { model: MODEL, envelope: parsed, usage });
        } catch (e) {
          send("error", {
            error: `report-advisor: ${e instanceof Error ? e.message : String(e)}`,
          });
        } finally {
          clearInterval(ping);
          open = false;
          try { controller.close(); } catch (_e) { /* already closed */ }
        }
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (e) {
    return json(
      { error: `report-advisor: ${e instanceof Error ? e.message : String(e)}` },
      500,
    );
  }
});
