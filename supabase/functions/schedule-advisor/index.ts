// supabase/functions/schedule-advisor/index.ts
// "Uncle Bob" — single-shot schedule advisor (D-AISCHED-03).
// Reads a snapshot, returns a briefing + evidence-cited placement proposals.
// WRITES NOTHING (D-RMF-05 precedent) — the panel owns all persistence.
// Auth mirrors extract-part-dimensions: service-role getUser(jwt), then a
// multi-role check (profiles.role OR profiles.roles[], D-MROLE-02) for
// admin | scheduler. Model: claude-fable-5 + extended thinking. The
// extraction functions stay on claude-sonnet-4-6 — unrelated to this file.
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

    // ── Call Anthropic ─────────────────────────────────────────────────────
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
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      return json({ error: `Anthropic API ${resp.status}: ${detail.slice(0, 400)}` }, 502);
    }
    const apiData = await resp.json();

    // Skip thinking blocks; take the last text block. Defensive fence-strip
    // (precedent: extract-part-dimensions / packing-slip-extract).
    const textBlocks = (apiData.content || []).filter((b: { type: string }) => b.type === "text");
    const raw = textBlocks.length ? textBlocks[textBlocks.length - 1].text : "";
    const cleaned = raw.replace(/```json|```/g, "").trim();

    let envelope;
    try {
      envelope = JSON.parse(cleaned);
    } catch {
      return json({ error: "Advisor returned unparseable output", raw: cleaned.slice(0, 800) }, 502);
    }

    // ── Server-side covenant enforcement ──────────────────────────────────
    // Trust nothing: placements must reference an unassigned job AND one of
    // that job's capable machines; estimate_only caps confidence at medium.
    const capable = new Map<string, Set<string>>();
    for (const j of snapshot.unassigned) {
      capable.set(
        j.job_id,
        new Set((j.capable_machines || []).map((c: { machine_id: string }) => c.machine_id)),
      );
    }
    const dropped: string[] = [];
    const placements = (Array.isArray(envelope.placements) ? envelope.placements : [])
      .filter((p: { job_id: string; machine_id: string; job_number?: string }) => {
        const ok = capable.has(p.job_id) && capable.get(p.job_id)!.has(p.machine_id);
        if (!ok) dropped.push(p.job_number || p.job_id);
        return ok;
      })
      .map((p: { evidence?: { basis?: string }; confidence?: string }) => {
        if (p.evidence?.basis === "estimate_only" && p.confidence === "high") {
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

    return json({
      model: MODEL,
      envelope: {
        briefing: typeof envelope.briefing === "string" ? envelope.briefing : "",
        risks: Array.isArray(envelope.risks) ? envelope.risks : [],
        placements,
        data_gaps,
      },
      usage: apiData.usage || null,
    });
  } catch (e) {
    return json({ error: `schedule-advisor: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
});
