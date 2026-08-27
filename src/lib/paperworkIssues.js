// Paperwork issues (D-PAPERWORK-01): a machinist flags a job's paperwork from
// the Kiosk with a mandatory description; compliance acknowledges it in
// Compliance Review. Writes go through two SECURITY DEFINER RPCs; reads are
// plain selects (SELECT is authenticated-wide, no direct write policies).
// Open issues change nothing on the job.
import { supabase } from './supabase'

export const MIN_DESCRIPTION = 10

// Open issues on one job — the Kiosk chip, so the next machinist sees the
// paperwork was already flagged instead of logging it twice.
export async function fetchOpenIssuesForJob(jobId) {
  if (!jobId) return []
  const { data, error } = await supabase
    .from('paperwork_issues')
    .select('id, job_document_id, document_label, description, logged_at, logger:profiles!logged_by(full_name)')
    .eq('job_id', jobId)
    .eq('status', 'open')
    .order('logged_at', { ascending: true })
  if (error) throw error
  return data || []
}

// Every open issue — the Compliance Review worklist. jobs → parts is two
// levels, the PostgREST nesting limit; nothing deeper is requested here.
export async function fetchOpenIssues() {
  const { data, error } = await supabase
    .from('paperwork_issues')
    .select(`
      id, job_id, job_document_id, document_label, machine_id, description, status, logged_by, logged_at,
      job:jobs!job_id(job_number, work_order_id, component:parts!component_id(part_number)),
      machine:machines!machine_id(code, name),
      logger:profiles!logged_by(full_name)
    `)
    .eq('status', 'open')
    .order('logged_at', { ascending: true })
  if (error) throw error
  return data || []
}

// Mainframe Pending Compliance KPI.
export async function countOpenIssues() {
  const { count, error } = await supabase
    .from('paperwork_issues')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'open')
  if (error) throw error
  return count || 0
}

export async function logPaperworkIssue({ jobId, description, jobDocumentId = null, machineId = null }) {
  const { data, error } = await supabase.rpc('log_paperwork_issue', {
    p_job_id: jobId,
    p_description: description,
    p_job_document_id: jobDocumentId || null,
    p_machine_id: machineId || null,
  })
  if (error) throw error
  return data
}

export async function ackPaperworkIssue(issueId, note) {
  const { error } = await supabase.rpc('ack_paperwork_issue', {
    p_issue_id: issueId,
    p_note: note || null,
  })
  if (error) throw error
}
