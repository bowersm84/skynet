// supabase/functions/schedule-advisor/index.ts
// "Uncle Bob" — single-shot schedule advisor (D-AISCHED-03, transport per
// D-AISCHED-07). Reads a snapshot, returns a briefing + evidence-cited
// placement proposals. WRITES NOTHING (D-RMF-05) — the panel owns all
// persistence.
//
// Transport (D-AISCHED-07): Fable 5 with extended thinking generates for
// minutes; a buffered response outlives the gateway window (observed:
// browser 502, worker EarlyDrop at ~200s with 44ms CPU). This function
// therefore streams: it consumes Anthropic's SSE server-side, sends the
// client a heartbeat comment every 10s while the model thinks, then exactly
// one `result` event with { model, envelope, usage } — or one `error` event.
// Fast-path failures (auth, validation, empty pool) still return plain JSON.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = "claude-fable-5";
const MAX_TOKENS = 16000;
const THINKING_BUDGET = 8000;
const MAX_SNAPSHOT_BYTES = 1_000_000;
const HEARTBEAT_MS = 10_000;
const ALLOWED_ROLES = ["admin", "scheduler"];

const SYSTEM_PROMPT = `You are "Uncle Bob", the schedule advisor inside SkyNet, the MES at Skybolt Aeromotive (aerospace fasteners, AS9100D). You receive a JSON snapshot of the live schedule board and reply with STRICT JSON only — no prose, no markdown fences, nothing outside one JSON object.

Your covenants. Violating any of these makes your output unusable:
1. Propose placements ONLY for jobs listed in unassigned[]. Never propose moving a job that is already scheduled or in progress.
2. For each job, propose ONLY machines listed in that job's capable_machines[]. No exceptions, even if another queue looks better.
3. Every placement cites evidence.basis: "part_history" | "family_history" | "estimate_only". With basis "estimate_only", confidence is at most "medium", and the rationale says plainly there is no run history — it is the scheduler's call, and the first run will create the history.
4. pending_compliance is the NORMAL state of unassigned work here (scheduling happens before compliance review by design). Do not flag it, caveat it, or treat it as a defect. Jobs with flags.has_open_shortfall: put them in risks[], do not place them.
5. Durations: prefer est_minutes_scaled corrected by history (est_vs_actual_drift); when you correct a duration, say so in the rationale.
6. The attended planning window is 07:00-16:00 Mon-Fri local. Jobs with requires_attendance=false may run past the window (lights-out); attended jobs may not. State assumptions rather than asserting certainty about material or attendance.
7. Honor every policies[] entry. If two policies conflict, or a policy conflicts with a due date, surface it in the briefing — never silently resolve it.

Also populate data_gaps[]: parts with no duration on any machine, stale estimates (|est_vs_actual_drift| > 0.25), and machines sitting with empty queues.

Reply with exactly this shape:
{
  "briefing": "short paragraph: the board in plain language — risks first, then opportunities",
  "risks": [{ "job_number": "...", "wo_number": "...", "severity": "high|medium|low", "issue": "..." }],
  "placements": [{
    "job_id": "...", "job_number": "...",
    "machine_id": "...", "machine_code": "...",
    "insert_after_job_id": null,
    "proposed_start": "ISO-8601", "proposed_end": "ISO-8601",
    "estimated_minutes": 0,
    "confidence": "high|medium|low",
    "rationale": "one or two sentences, evidence-forward",
    "evidence": { "basis": "part_history|family_history|estimate_only",
                  "runs": 0, "actual_pcs_per_hour": 0,
                  "est_vs_actual_drift": 0, "last_run_at": "..." }
  }],
  "data_gaps": ["..."]
}`;

// Server-side covenant enforcement: trust nothing. Placements must reference
// an unassigned job AND one of that job's capable machines; estimate_only
// caps confidence at medium. Violations are dropped and noted in data_gaps.
function enforceCovenants(envelope: Record<string, unknown>, snapshot: Record<string, unknown>) {
  const capable = new Map<string, Set<string>>();
  for (const j of (snapshot.unassigned as Array<Record<string, unknown>>)) {
    capable.set(
      j.job_id as string,
      new Set(((j.capable_machines as Array<Record<string, unknown>>) || [])
        .map((c) => c.machine_id as string)),
    );
  }
  const dropped: string[] = [];
  const placements = (Array.isArray(envelope.placements) ? envelope.placements : [])
    .filter((p: Record<string, unknown>) => {
      const ok = capable.has(p.job_id as string) &&
        capable.get(p.job_id as string)!.has(p.machine_id as string);
      if (!ok) dropped.push((p.job_number as string) || (p.job_id as string));
      return ok;
    })
    .map((p: Record<string, unknown>) => {
      const ev = p.evidence as Record<string, unknown> | undefined;
      if (ev?.basis === "estimate_only" && p.confidence === "high") {
        return { ...p, confidence: "medium" };
      }
      return p;
    });

  const data_gaps = Array.isArray(envelope.data_gaps) ? envelope.data_gaps : [];
  if (dropped.length) {
    data_gaps.push(
      `Server-side covenant check dropped ${dropped.length} placement(s) referencing non-capable machines or unknown jobs: ${dropped.join(", ")}`,
    );
  }
  return {
    briefing: typeof envelope.briefing === "string" ? envelope.briefing : "",
    risks: Array.isArray(envelope.risks) ? envelope.risks : [],
    placements,
    data_gaps,
  };
}

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
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Missing Authorization header" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return json({ error: "Invalid or expired session" }, 401);
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
      return json({ error: "schedule-advisor requires admin or scheduler" }, 403);
    }

    // ── Reject before spend ────────────────────────────────────────────────
    const body = await req.json().catch(() => null);
    const snapshot = body?.snapshot;
    if (!snapshot || !Array.isArray(snapshot.machines) || !Array.isArray(snapshot.unassigned)) {
      return json({ error: "Body must be { snapshot } with machines[] and unassigned[]" }, 400);
    }
    const serialized = JSON.stringify(snapshot);
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      return json({ error: `Snapshot too large (${serialized.length} bytes; limit ${MAX_SNAPSHOT_BYTES})` }, 400);
    }
    if (snapshot.unassigned.length === 0) {
      return json({
        model: MODEL,
        envelope: {
          briefing: "The unassigned pool is empty — nothing to place. The board is what it is.",
          risks: [], placements: [], data_gaps: [],
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
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
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
              thinking: { type: "enabled", budget_tokens: THINKING_BUDGET },
              system: SYSTEM_PROMPT,
              messages: [{ role: "user", content: serialized }],
              stream: true,
            }),
          });

          if (!resp.ok || !resp.body) {
            const detail = await resp.text().catch(() => "");
            send("error", { error: `Anthropic API ${resp.status}: ${detail.slice(0, 400)}` });
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
              const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
              if (!dataLine) continue;
              let payload: Record<string, unknown>;
              try { payload = JSON.parse(dataLine.slice(6)); } catch { continue; }
              const type = payload.type as string;
              if (type === "error") {
                const err = payload.error as Record<string, unknown> | undefined;
                send("error", { error: `Anthropic stream error: ${err?.message ?? "unknown"}` });
                return;
              }
              if (type === "message_start") {
                const u = (payload.message as Record<string, unknown> | undefined)?.usage;
                if (u) usage = { ...(usage || {}), ...(u as Record<string, unknown>) };
              }
              if (type === "message_delta" && payload.usage) {
                usage = { ...(usage || {}), ...(payload.usage as Record<string, unknown>) };
              }
              if (type === "content_block_delta") {
                const delta = payload.delta as Record<string, unknown> | undefined;
                if (delta?.type === "text_delta") text += delta.text as string;
              }
            }
          }

          const cleaned = text.replace(/```json|```/g, "").trim();
          let envelope: Record<string, unknown>;
          try {
            envelope = JSON.parse(cleaned);
          } catch {
            send("error", { error: "Advisor returned unparseable output", raw: cleaned.slice(0, 800) });
            return;
          }

          send("result", {
            model: MODEL,
            envelope: enforceCovenants(envelope, snapshot),
            usage,
          });
        } catch (e) {
          send("error", { error: `schedule-advisor: ${e instanceof Error ? e.message : String(e)}` });
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
    return json({ error: `schedule-advisor: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
});
