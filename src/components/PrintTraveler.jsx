import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Loader2 } from 'lucide-react'

export default function PrintTraveler({ jobId: propJobId, onClose }) {
  const params = useParams()
  const jobId = propJobId || params.jobId
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const { data: job, error: jobError } = await supabase
          .from('jobs')
          .select(`
            id,
            job_number,
            quantity,
            status,
            work_order:work_orders (
              wo_number,
              customer,
              po_number,
              due_date,
              order_type,
              order_quantity,
              stock_quantity
            ),
            component:parts!component_id (
              part_number,
              description,
              drawing_revision,
              requires_passivation,
              material_type:material_types (
                name
              )
            )
          `)
          .eq('id', jobId)
          .single()

        if (jobError) throw jobError

        const { data: steps, error: stepsError } = await supabase
          .from('job_routing_steps')
          .select('*')
          .eq('job_id', jobId)
          .neq('status', 'removed')
          .order('step_order')

        if (stepsError) throw stepsError

        setData({ job, steps: steps || [] })
      } catch (err) {
        console.error('Error fetching traveler data:', err)
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [jobId])

  useEffect(() => {
    if (data && !loading) {
      // Brief delay to let the DOM render, then trigger print
      const timer = setTimeout(() => window.print(), 300)
      return () => clearTimeout(timer)
    }
  }, [data, loading])

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

  const { job, steps } = data
  const wo = job.work_order
  const comp = job.component

  const formatDate = (dateStr) => {
    if (!dateStr) return '—'
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
  }

  // Build quantity display
  let qtyDisplay = String(job.quantity)
  if (wo?.order_type === 'make_to_order' && wo?.order_quantity && wo?.stock_quantity) {
    qtyDisplay = `${wo.order_quantity} order + ${wo.stock_quantity} stock = ${job.quantity} total`
  } else if (wo?.order_type === 'make_to_stock') {
    qtyDisplay = `${job.quantity} (stock)`
  }

  // Add blank rows for floor additions
  const BLANK_ROWS = 3
  const printTime = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  })

  return (
    <>
      {/* Print-only styles */}
      <style>{`
        @media print {
          body { margin: 0; padding: 0; }
          .no-print { display: none !important; }
          .print-page { padding-top: 0 !important; }
          @page { size: landscape; margin: 0.5in; }
        }
        @media screen {
          .print-page { max-width: 11in; margin: 0 auto; padding: 0.5in; }
        }
      `}</style>

      {/* Screen-only close bar */}
      <div className="no-print" style={{
        position: 'fixed', top: 0, left: 0, right: 0,
        background: '#1a1a2e', padding: '12px 24px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        zIndex: 100, borderBottom: '1px solid #333'
      }}>
        <span style={{ color: '#aaa', fontSize: '14px' }}>
          Traveler Preview — {job.job_number}
        </span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => window.print()}
            style={{
              background: '#16a34a', color: 'white', border: 'none',
              padding: '8px 16px', borderRadius: '6px', cursor: 'pointer',
              fontSize: '14px', fontWeight: 500
            }}
          >
            Print
          </button>
          <button
            onClick={onClose || (() => window.close())}
            style={{
              background: '#374151', color: 'white', border: 'none',
              padding: '8px 16px', borderRadius: '6px', cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            Close
          </button>
        </div>
      </div>

      {/* Print content */}
      <div className="print-page" style={{
        fontFamily: 'Arial, Helvetica, sans-serif',
        color: '#000', background: '#fff',
        paddingTop: '60px' /* account for screen toolbar */
      }}>
        {/* Title */}
        <div style={{
          textAlign: 'center', borderBottom: '3px solid #000',
          paddingBottom: '8px', marginBottom: '16px'
        }}>
          <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 'bold', letterSpacing: '2px' }}>
            SKYBOLT AEROMOTIVE — JOB TRAVELER
          </h1>
        </div>

        {/* Header Fields Grid */}
        <table style={{
          width: '100%', borderCollapse: 'collapse',
          marginBottom: '16px', fontSize: '13px'
        }}>
          <tbody>
            <tr>
              <td style={headerLabelStyle}>Part Number</td>
              <td style={headerValueStyle}>{comp?.part_number || '—'}</td>
              <td style={headerLabelStyle}>Job Number</td>
              <td style={headerValueStyle}>{job.job_number}</td>
            </tr>
            <tr>
              <td style={headerLabelStyle}>Description</td>
              <td style={headerValueStyle}>{comp?.description || '—'}</td>
              <td style={headerLabelStyle}>Order / WO #</td>
              <td style={headerValueStyle}>{wo?.wo_number || '—'}</td>
            </tr>
            <tr>
              <td style={headerLabelStyle}>Material</td>
              <td style={headerValueStyle}>{comp?.material_type?.name || '—'}</td>
              <td style={headerLabelStyle}>PO Number</td>
              <td style={headerValueStyle}>{wo?.po_number || '—'}</td>
            </tr>
            <tr>
              <td style={headerLabelStyle}>Drawing Rev</td>
              <td style={headerValueStyle}>{comp?.drawing_revision || '—'}</td>
              <td style={headerLabelStyle}>Due Date</td>
              <td style={headerValueStyle}>{formatDate(wo?.due_date)}</td>
            </tr>
            <tr>
              <td style={headerLabelStyle}>Customer</td>
              <td style={headerValueStyle}>
                {wo?.order_type === 'make_to_stock' ? 'STOCK' : (wo?.customer || '—')}
              </td>
              <td style={headerLabelStyle}>Quantity</td>
              <td style={{ ...headerValueStyle, fontWeight: 'bold' }}>{qtyDisplay}</td>
            </tr>
          </tbody>
        </table>

        {/* Routing Steps Table */}
        <table style={{
          width: '100%', borderCollapse: 'collapse',
          fontSize: '12px', marginBottom: '16px'
        }}>
          <thead>
            <tr>
              {['Step', 'Process', 'Station', 'Type', 'Lot #', 'Qty', 'Date', 'Operator'].map(col => (
                <th key={col} style={routingHeaderStyle}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {steps.map(step => (
              <tr key={step.id}>
                <td style={{ ...routingCellStyle, textAlign: 'center', width: '40px' }}>
                  {step.step_order}
                </td>
                <td style={routingCellStyle}>
                  {step.step_name}
                  {step.is_added_step && ' *'}
                </td>
                <td style={{ ...routingCellStyle, width: '90px' }}>
                  {step.station || ''}
                </td>
                <td style={{ ...routingCellStyle, textAlign: 'center', width: '45px' }}>
                  {step.step_type === 'external' ? 'EXT' : 'INT'}
                </td>
                <td style={{ ...routingCellStyle, width: '90px' }}></td>
                <td style={{ ...routingCellStyle, width: '55px' }}></td>
                <td style={{ ...routingCellStyle, width: '80px' }}></td>
                <td style={{ ...routingCellStyle, width: '90px' }}></td>
              </tr>
            ))}
            {/* Blank rows for floor additions */}
            {Array.from({ length: BLANK_ROWS }).map((_, i) => (
              <tr key={`blank-${i}`}>
                <td style={{ ...routingCellStyle, textAlign: 'center' }}>&nbsp;</td>
                <td style={routingCellStyle}>&nbsp;</td>
                <td style={routingCellStyle}>&nbsp;</td>
                <td style={routingCellStyle}>&nbsp;</td>
                <td style={routingCellStyle}>&nbsp;</td>
                <td style={routingCellStyle}>&nbsp;</td>
                <td style={routingCellStyle}>&nbsp;</td>
                <td style={routingCellStyle}>&nbsp;</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Notes area */}
        <div style={{
          border: '1px solid #000', padding: '8px',
          marginBottom: '16px', minHeight: '60px', fontSize: '12px'
        }}>
          <strong>Notes:</strong>
        </div>

        {/* Footer */}
        <div style={{
          borderTop: '1px solid #999', paddingTop: '8px',
          display: 'flex', justifyContent: 'space-between',
          fontSize: '10px', color: '#666'
        }}>
          <span>Printed from SkyNet MES — {printTime}</span>
          <span>Skybolt Aeromotive Corp</span>
        </div>
      </div>
    </>
  )
}

// Style constants
const headerLabelStyle = {
  padding: '4px 8px',
  fontWeight: 'bold',
  backgroundColor: '#f0f0f0',
  border: '1px solid #ccc',
  width: '15%',
  whiteSpace: 'nowrap'
}

const headerValueStyle = {
  padding: '4px 8px',
  border: '1px solid #ccc',
  width: '35%'
}

const routingHeaderStyle = {
  padding: '6px 8px',
  backgroundColor: '#222',
  color: '#fff',
  fontWeight: 'bold',
  border: '1px solid #000',
  textAlign: 'left'
}

const routingCellStyle = {
  padding: '8px',
  border: '1px solid #000',
  height: '28px',
  verticalAlign: 'middle'
}
