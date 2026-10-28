// SkyNet — Edge Function: uncle-bob-program (S16 Batch C, D-CPROG-13, 14, 16)
// Uncle Bob on a customer program dashboard. A roster member asks a question; Bob answers from
// the dashboard's snapshot (sent by the page: lines, stages, blockers, credit plan, money, lots,
// quotes) and the program's email trail (loaded here, server-side, so the exclusions hold no
// matter what the page sends). Reads only; never sends anything. Every question and answer is
// saved in cp_ai_threads for the whole roster (D-CPROG-14).
//
// Email rules (Matt, Oct 28 — D-CPROG-16): hidden messages and any message with
// bob_excluded_reason (export-control / CUI marking, or "Keep from Uncle Bob") never reach the
// model. Attachments were never stored (D-CPROG-09); Bob sees their names only.
//
// Auth: the caller's JWT (deploy with JWT verification ON) + customer_program_access for the
// program. Streams SSE with 10-second heartbeats, same framing as report-advisor (D-AISCHED-07).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { buildEmailContext, parseBobOutput, SYSTEM_PROMPT, HISTORY_TURNS, type EmailRow } from './context.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
// Opus 5.5 (Matt, Oct 28): about 60% cheaper than Fable 5 per token; adaptive thinking is always on.
const MODEL = 'claude-opus-5-5'
// Thinking counts against max_tokens; with the trail in context 4,000 cut answers off mid-JSON.
const MAX_TOKENS = 32000
const THINKING_EFFORT = 'medium'
// Structured outputs (output_config.format): the API guarantees the answer is valid JSON in this
// shape, so "unparseable output" can't happen on a finished answer.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['email', 'order', 'money', 'lot', 'quote'] },
          ref: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['kind', 'ref', 'label'],
        additionalProperties: false,
      },
    },
    draft: {
      anyOf: [
        {
          type: 'object',
          properties: {
            to: { type: 'array', items: { type: 'string' } },
            subject: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['to', 'subject', 'body'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
    data_gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'citations', 'draft', 'data_gaps'],
  additionalProperties: false,
}
const HEARTBEAT_MS = 10_000
const MAX_SNAPSHOT_BYTES = 400_000
const MAX_QUESTION_CHARS = 2000
const MAX_EMAIL_ROWS = 5000

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!jwt) return json({ error: 'Missing Authorization header' }, 401)
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt)
    if (userErr || !userData?.user) return json({ error: 'Invalid session — sign in again.' }, 401)
    const userId = userData.user.id

    const body = await req.json().catch(() => null)
    const question = String(body?.question || '').trim()
    const snapshot = body?.snapshot
    if (!question) return json({ error: 'Ask a question first.' }, 400)
    if (question.length > MAX_QUESTION_CHARS) return json({ error: `Question too long (limit ${MAX_QUESTION_CHARS} characters)` }, 400)
    if (!snapshot || typeof snapshot !== 'object') return json({ error: 'Missing snapshot' }, 400)
    const snapshotText = JSON.stringify(snapshot)
    if (snapshotText.length > MAX_SNAPSHOT_BYTES) return json({ error: `Snapshot too large (${snapshotText.length} bytes)` }, 400)

    const { data: program } = await admin.from('customer_programs')
      .select('id, code, name').eq('code', String(body?.program_code || '').toUpperCase()).maybeSingle()
    if (!program) return json({ error: 'Program not found' }, 404)
    const { data: access } = await admin.from('customer_program_access')
      .select('profile_id').eq('program_id', program.id).eq('profile_id', userId).maybeSingle()
    if (!access) return json({ error: 'Forbidden: not on this program\'s roster' }, 403)

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500)

    // Email trail, paged (the API returns at most 1,000 rows per read).
    const rows: EmailRow[] = []
    for (let from = 0; from < MAX_EMAIL_ROWS; from += 1000) {
      const { data, error } = await admin.from('cp_emails')
        .select('id, sent_at, from_name, from_addr, to_addrs, cc_addrs, subject, body_new, direction, refs, attachments, hidden_at, bob_excluded_reason')
        .eq('program_id', program.id).order('sent_at', { ascending: false }).range(from, from + 999)
      if (error) return json({ error: `emails: ${error.message}` }, 500)
      rows.push(...(data || []))
      if (!data || data.length < 1000) break
    }
    const ctx = buildEmailContext(rows)

    const { data: hist } = await admin.from('cp_ai_threads')
      .select('question, answer, created_at').eq('program_id', program.id).not('answer', 'is', null)
      .order('created_at', { ascending: false }).limit(HISTORY_TURNS)

    const { data: thread, error: tErr } = await admin.from('cp_ai_threads').insert({
      program_id: program.id, asked_by: userId, question,
      emails_in_context: ctx.included, emails_excluded: ctx.excluded, model: MODEL,
    }).select('id').single()
    if (tErr) return json({ error: `could not record the question: ${tErr.message}` }, 500)

    const userContent = JSON.stringify({
      program: { code: program.code, name: program.name },
      today: new Date().toISOString().slice(0, 10),
      question,
      snapshot,
      email_counts: {
        given_to_you: ctx.included,
        withheld_hidden_or_excluded: ctx.excluded,
        left_out_for_length_oldest_first: ctx.truncated,
      },
      emails: ctx.messages,
      history: (hist || []).reverse().map(h => ({ asked: h.created_at, question: h.question, answer: h.answer })),
    })

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        let open = true
        const send = (event: string, data: unknown) => {
          if (!open) return
          try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) } catch (_e) { open = false }
        }
        const ping = setInterval(() => {
          if (!open) return
          try { controller.enqueue(encoder.encode(`: ping\n\n`)) } catch (_e) { open = false }
        }, HEARTBEAT_MS)
        const fail = async (message: string) => {
          await admin.from('cp_ai_threads').update({ error: message.slice(0, 1000), finished_at: new Date().toISOString() }).eq('id', thread.id)
          send('error', { error: message })
        }
        try {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({
              model: MODEL, max_tokens: MAX_TOKENS,
              thinking: { type: 'adaptive' },
              output_config: { effort: THINKING_EFFORT, format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
              system: SYSTEM_PROMPT,
              messages: [{ role: 'user', content: userContent }],
              stream: true,
            }),
          })
          if (!resp.ok || !resp.body) {
            const detail = await resp.text().catch(() => '')
            await fail(`Anthropic API ${resp.status}: ${detail.slice(0, 400)}`)
            return
          }
          const reader = resp.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''
          let text = ''
          let usage: Record<string, unknown> | null = null
          let stopReason: string | null = null
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const frames = buf.split('\n\n')
            buf = frames.pop() ?? ''
            for (const frame of frames) {
              const dataLine = frame.split('\n').find(l => l.startsWith('data: '))
              if (!dataLine) continue
              let payload: Record<string, unknown>
              try { payload = JSON.parse(dataLine.slice(6)) } catch { continue }
              const type = payload.type as string
              if (type === 'error') {
                const err = payload.error as Record<string, unknown> | undefined
                await fail(`Anthropic stream error: ${err?.message ?? 'unknown'}`)
                return
              }
              if (type === 'message_start') {
                const u = (payload.message as Record<string, unknown> | undefined)?.usage
                if (u) usage = { ...(usage || {}), ...(u as Record<string, unknown>) }
              }
              if (type === 'message_delta' && payload.usage) usage = { ...(usage || {}), ...(payload.usage as Record<string, unknown>) }
              if (type === 'message_delta') {
                const sr = (payload.delta as Record<string, unknown> | undefined)?.stop_reason
                if (sr) stopReason = String(sr)
              }
              if (type === 'content_block_delta') {
                const delta = payload.delta as Record<string, unknown> | undefined
                if (delta?.type === 'text_delta') text += delta.text as string
              }
            }
          }
          if (stopReason === 'max_tokens') {
            await fail('Uncle Bob\'s answer was cut off before it finished. Try a narrower question.')
            return
          }
          if (stopReason === 'refusal') {
            await fail('Uncle Bob declined to answer this one.')
            return
          }
          let result
          try { result = parseBobOutput(text, ctx.keyMap) } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            await fail(`${msg} (stop reason: ${stopReason ?? 'none'}; ${text.length} characters of answer received)`)
            return
          }
          await admin.from('cp_ai_threads').update({
            answer: result.answer, citations: result.citations, draft: result.draft, data_gaps: result.data_gaps,
            usage, finished_at: new Date().toISOString(),
          }).eq('id', thread.id)
          send('result', { thread_id: thread.id, model: MODEL, usage, email_counts: { included: ctx.included, excluded: ctx.excluded, truncated: ctx.truncated }, ...result })
        } catch (e) {
          await fail(`uncle-bob-program: ${e instanceof Error ? e.message : String(e)}`)
        } finally {
          clearInterval(ping)
          open = false
          try { controller.close() } catch (_e) { /* already closed */ }
        }
      },
    })
    return new Response(stream, {
      headers: { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    })
  } catch (e) {
    return json({ error: `uncle-bob-program: ${e instanceof Error ? e.message : String(e)}` }, 500)
  }
})
