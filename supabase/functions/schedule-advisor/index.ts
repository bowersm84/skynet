// supabase/functions/schedule-advisor/index.ts
// "Uncle Bob" — single-shot schedule advisor (D-AISCHED-03; transport per
// D-AISCHED-07; capability model per D-AISCHED-09). Reads a snapshot, returns
// a briefing + evidence-cited placement proposals. WRITES NOTHING (D-RMF-05).
//
// Capability (D-AISCHED-09): a machine is eligible for a job if ANY of —
//   1. history: the part has completed runs on it (strongest evidence),
//   2. standing rule: an active policy explicitly names the part/family on
//      that machine (model cites the rule verbatim; server verifies the rule
//      text names the machine),
//   3. master data: part_machine_durations lists it (weakest; optional).
// Preference and duration precedence follow the same ladder.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = "claude-fable-5";
const MAX_TOKENS = 16000;
// Fable 5 (Mythos-class) controls thinking via adaptive + effort, not a
// token budget (D-AISCHED-08). "high" per the cost-no-object direction.
const THINKING_EFFORT = "high";
const MAX_SNAPSHOT_BYTES = 1_000_000;
const HEARTBEAT_MS = 10_000;
const ALLOWED_ROLES = ["admin", "scheduler"];

const SYSTEM_PROMPT = `You are "Uncle Bob", the schedule advisor inside SkyNet, the MES at Skybolt Aeromotive (aerospace fasteners, AS9100D). You receive a JSON snapshot of the live schedule board and reply with STRICT JSON only — no prose, no markdown fences, nothing outside one JSON object.

Your covenants. Violating any of these makes your output unusable:
1. Propose placements ONLY for jobs listed in unassigned[]. Never propose moving a job that is already scheduled or in progress.
2. Machine eligibility comes from three sources, in order of authority:
   (a) HISTORY — capable_machines[] entries whose sources include "history". The part has completed runs there; that is proof of capability and the strongest evidence you have.
   (b) STANDING RULES — an entry in policies[] that explicitly names this part (or its family) on a machine grants capability even when the machine is absent from capable_machines[]. When you use one, set evidence.basis to "policy" and put the rule text verbatim in evidence.policy.
   (c) MASTER DATA — capable_machines[] entries whose sources include "master_data". Hand-maintained and often sparse; treat as suggestion, not gatekeeper.
   Never place a job on a machine supported by none of the three.
3. When several machines qualify, prefer them in that same order: proven-by-history first (more runs and better observed rates win), then rule-named, then master-data-only. preferred=true breaks ties.
4. evidence.basis is one of "part_history" | "family_history" | "policy" | "estimate_only". With basis "policy" and no run history on that machine, or basis "estimate_only", confidence is at most "medium", and the rationale says plainly there is no run history — it is the scheduler's call, and the first run will create the history.
5. pending_compliance is the NORMAL state of unassigned work here (scheduling happens before compliance review by design). Do not flag it, caveat it, or treat it as a defect. Jobs with flags.has_open_shortfall: put them in risks[], do not place them.
6. Durations, in order of trust: history-derived time (est_minutes_from_history, or est_minutes_scaled corrected by est_vs_actual_drift) > est_minutes_scaled from master data > the job's own estimated_minutes (machine-agnostic — say it is uncorrected) > none, in which case say plainly the scheduler sets the time. Always say which you used.
7. The attended planning window is 07:00-16:00 Mon-Fri local. Jobs with requires_attendance=false may run past the window (lights-out); attended jobs may not. State assumptions rather than asserting certainty about material or attendance.
8. Honor every policies[] entry. A standing rule granting capability is an instruction to use, not a conflict to report. If two policies conflict, or a policy conflicts with a due date or a down machine, surface that in the briefing — never silently resolve it.
9. Identify work by PART NUMBER first, everywhere — briefing, risks, placements, data_gaps. Job numbers are secondary context. This is a shop standard.

Also populate data_gaps[]: parts with no capability from any source, stale estimates (|est_vs_actual_drift| > 0.25), and machines sitting with empty queues.

Reply with exactly this shape:
{
  "briefing": "short paragraph: the board in plain language — risks first, then opportunities",
  "risks": [{ "part_number": "...", "job_number": "...", "wo_number": "...", "severity": "high|medium|low", "issue": "..." }],
  "placements": [{
    "job_id": "...", "job_number": "...", "part_number": "...",
    "machine_id": "...", "machine_code": "...",
    "insert_after_job_id": null,
    "proposed_start": "ISO-8601", "proposed_end": "ISO-8601",
    "estimated_minutes": 0,
    "confidence": "high|medium|low",
    "rationale": "one or two sentences, evidence-forward, part number first",
    "evidence": { "basis": "part_history|family_history|policy|estimate_only",
                  "policy": "verbatim rule text when basis is policy",
                  "runs": 0, "actual_pcs_per_hour": 0,
                  "est_vs_actual_drift": 0, "last_run_at": "..." }
  }],
  "data_gaps": ["..."]
}`;

// Server-side covenant enforcement: trust nothing. A placement must land on a
// machine that is (a) in that job's capable_machines[] (already the union of
// history + master data), or (b) authorized by a standing rule — basis
// "policy" AND some active policy's text literally contains that machine's
// name or code. Policy-authorized machines without run history are capped at
// medium confidence. Violations are dropped and noted in data_gaps.
function enforceCovenants(envelope: Record<string, unknown>, snapshot: Record<string, unknown>) {
  const capable = new Map<string, Set<string>>();
  const historyOn = new Map<string, Set<string>>();
  for (const j of (snapshot.unassigned as Array<Record<string, unknown>>)) {
    const caps = (j.capable_machines as Array<Record<string, unknown>>) || [];
    capable.set(j.job_id as string, new Set(caps.map((c) => c.machine_id as string)));
    historyOn.set(
      j.job_id as string,
      new Set(caps.filter((c) => c.history).map((c) => c.machine_id as string)),
    );
  }

  const machineNames = new Map<string, { name: string; code: string }>();
  for (const m of ((snapshot.machines as Array<Record<string, unknown>>) || [])) {
    machineNames.set(m.machine_id as string, {
      name: String(m.name || "").toLowerCase(),
      code: String(m.code || "").toLowerCase(),
    });
  }
  const policies = ((snapshot.policies as string[]) || []).map((t) => String(t).toLowerCase());
  // Containment check on full machine name or code. Cheap and honest for a
  // shop this size; "Mazak 1" ⊂ "Carlos' machines (Mazak 1 and 2)". Note a
  // rule naming "Mazak 10" would also contain "Mazak 1" — acceptable here
  // (no Mazak 10 exists); revisit if the fleet ever grows overlapping names.
  const policyNamesMachine = (machineId: string) => {
    const m = machineNames.get(machineId);
    if (!m) return false;
    return policies.some((p) =>
      (m.name.length >= 3 && p.includes(m.name)) ||
      (m.code.length >= 3 && p.includes(m.code)),
    );
  };

  const dropped: string[] = [];
  const placements = (Array.isArray(envelope.placements) ? envelope.placements : [])
    .filter((p: Record<string, unknown>) => {
      const jobId = p.job_id as string;
      const machineId = p.machine_id as string;
      if (!capable.has(jobId)) { dropped.push(labelOf(p)); return false; }
      const inUnion = capable.get(jobId)!.has(machineId);
      const ev = p.evidence as Record<string, unknown> | undefined;
      const byPolicy = ev?.basis === "policy" && policyNamesMachine(machineId);
      if (!inUnion && !byPolicy) { dropped.push(labelOf(p)); return false; }
      return true;
    })
    .map((p: Record<string, unknown>) => {
      const ev = p.evidence as Record<string, unknown> | undefined;
      const jobId = p.job_id as string;
      const machineId = p.machine_id as string;
      const hasHistory = historyOn.get(jobId)?.has(machineId) === true;
      const mustCap =
        ev?.basis === "estimate_only" ||
        (ev?.basis === "policy" && !hasHistory);
      if (mustCap && p.confidence === "high") {
        return { ...p, confidence: "medium" };
      }
      return p;
    });

  const data_gaps = Array.isArray(envelope.data_gaps) ? envelope.data_gaps : [];
  if (dropped.length) {
    data_gaps.push(
      `Server-side covenant check dropped ${dropped.length} placement(s) with no capability from history, standing rules, or master data: ${dropped.join(", ")}`,
    );
  }
  return {
    briefing: typeof envelope.briefing === "string" ? envelope.briefing : "",
    risks: Array.isArray(envelope.risks) ? envelope.risks : [],
    placements,
    data_gaps,
  };
}

function labelOf(p: Record<string, unknown>): string {
  return (p.part_number as string) || (p.job_number as string) || (p.job_id as string);
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
              thinking: { type: "adaptive" },
              output_config: { effort: THINKING_EFFORT },
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
