// src/components/PrintTraveler.jsx — thin wrapper over the canonical traveler
// builder (D-JOBMERGE-05). This replaces an early-development duplicate
// renderer that had drifted (no lot/qty/date/operator columns, no CO table,
// no genealogy, no merge info). The route /print/traveler/:jobId now renders
// the same HTML as every other traveler surface: fetchTravelerData assembles
// the full dataset (including mergeInfo), buildTravelerHTML renders it, and
// the print stamp records a print of CURRENT paperwork — which is what lets
// it clear the stale-traveler flag honestly.
import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Loader2 } from 'lucide-react'
import { fetchTravelerData, buildTravelerHTML } from '../lib/traveler'

export default function PrintTraveler({ jobId: propJobId }) {
  const params = useParams()
  const jobId = propJobId || params.jobId
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [html, setHtml] = useState(null)
  const iframeRef = useRef(null)
  const printedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const travelerData = await fetchTravelerData(supabase, jobId)
        if (!travelerData) {
          throw new Error('Job not found (or you are not signed in)')
        }
        if (cancelled) return
        setHtml(buildTravelerHTML(travelerData))
        // D-JOBMERGE-05: record the print — staleness clears by timestamp.
        // The route runs outside the app shell, so resolve the signer from the
        // live session rather than a profile prop. Non-blocking: a stamp
        // failure never breaks the print.
        supabase.auth.getUser().then(({ data: authData }) => {
          supabase
            .from('jobs')
            .update({
              traveler_printed_at: new Date().toISOString(),
              traveler_printed_by: authData?.user?.id || null,
            })
            .eq('id', jobId)
            .then(({ error: stampErr }) => {
              if (stampErr) {
                console.error('traveler_printed stamp failed (non-blocking):', stampErr)
              }
            })
        })
      } catch (err) {
        console.error('Error loading traveler:', err)
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    if (jobId) load()
    return () => { cancelled = true }
  }, [jobId])

  // Preserve the original component's auto-print behavior: once the canonical
  // document lays out inside the iframe, open the print dialog. The built HTML
  // hides its toolbar via .no-print and sets landscape @page rules itself.
  const handleFrameLoad = () => {
    if (printedRef.current) return
    printedRef.current = true
    setTimeout(() => {
      const w = iframeRef.current?.contentWindow
      if (w) {
        w.focus()
        w.print()
      }
    }, 300)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-white">
        <Loader2 size={32} className="animate-spin text-gray-400" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-white">
        <div className="text-center">
          <p className="text-red-600 text-lg">Error loading traveler</p>
          <p className="text-gray-500 text-sm mt-1">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <iframe
      ref={iframeRef}
      title={`Job Traveler ${jobId}`}
      srcDoc={html}
      onLoad={handleFrameLoad}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        border: 'none',
        background: '#fff',
      }}
    />
  )
}
