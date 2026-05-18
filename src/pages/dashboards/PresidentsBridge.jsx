import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { FEATURES } from '../../config'
import { deriveMachineStatus } from '../../lib/machineStatus'

// Ned's T-0: Skybolt founding day, 23 March 1982 (Apollo program alumnus, founded Skybolt 7 years after Apollo-Soyuz)
const LAUNCH_DATE = new Date('1982-03-23T00:00:00')

// Map jobs.status values into trajectory pipeline stages
const STATUS_GROUPS = {
  preLaunch: ['pending_compliance'],
  production: ['ready', 'assigned', 'in_setup', 'in_progress'],
  cruise: [
    'manufacturing_complete',
    'pending_passivation',
    'in_passivation',
    'pending_post_manufacturing',
    'ready_for_outsourcing',
    'at_external_vendor',
  ],
  approach: ['ready_for_assembly', 'in_assembly'],
  splashdown: ['pending_tco'],
}

export default function PresidentsBridge() {
  const navigate = useNavigate()
  const [phase, setPhase] = useState('auth') // 'auth' | 'authorized' | 'denied'
  const [profile, setProfile] = useState(null)
  const [data, setData] = useState({
    ordersInFlight: 0,
    machinesProducing: 0,
    machinesTotal: 0,
    machinesDown: 0,
    machinesIdle: 0,
    complianceQueue: 0,
    finishingQueue: 0,
    trajectory: { preLaunch: 0, production: 0, cruise: 0, approach: 0, splashdown: 0 },
    priorityParts: [],
  })
  const [lastUpdated, setLastUpdated] = useState(null)
  const [, setTick] = useState(0) // forces re-render so MET/clock refresh

  // Inject Google Fonts once
  useEffect(() => {
    const href = 'https://fonts.googleapis.com/css2?family=Black+Ops+One&family=JetBrains+Mono:wght@300;400;500;700&family=Major+Mono+Display&display=swap'
    if (!document.querySelector(`link[data-bridge-fonts="1"]`)) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      link.setAttribute('data-bridge-fonts', '1')
      document.head.appendChild(link)
    }
  }, [])

  // Auth + role gate
  useEffect(() => {
    let mounted = true
    async function checkAuth() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.user) {
        navigate('/')
        return
      }
      const { data: prof, error } = await supabase
        .from('profiles')
        .select('id, full_name, role, email')
        .eq('id', session.user.id)
        .single()
      if (!mounted) return
      if (error || !prof) {
        navigate('/')
        return
      }
      if (!['president', 'admin'].includes(prof.role)) {
        setPhase('denied')
        return
      }
      setProfile(prof)
      setPhase('authorized')
    }
    checkAuth()
    return () => { mounted = false }
  }, [navigate])

  // Tick every 60s for the MET counter / clock displays
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60000)
    return () => clearInterval(id)
  }, [])

  // Data load with 60s polling
  useEffect(() => {
    if (phase !== 'authorized') return
    let cancelled = false

    async function loadData() {
      try {
        const [woRes, machinesRes, machineJobsRes, complianceRes, finishingRes, jobsRes] = await Promise.all([
          // 1. Orders in flight — open work orders
          supabase
            .from('work_orders')
            .select('id', { count: 'exact', head: true })
            .not('status', 'in', '(complete,shipped,closed,cancelled)'),
          // 2. Machines (status + kiosk_enabled needed for derived taxonomy)
          supabase
            .from('machines')
            .select('id, status, kiosk_enabled')
            .eq('is_active', true),
          // 2b. Jobs assigned to machines, in active/queued states — feeds deriveMachineStatus
          supabase
            .from('jobs')
            .select('id, status, assigned_machine_id')
            .in('status', ['in_setup', 'in_progress', 'ready', 'assigned'])
            .not('assigned_machine_id', 'is', null),
          // 3. Compliance queue — jobs awaiting compliance
          supabase
            .from('jobs')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'pending_compliance'),
          // 4. Finishing queue — batches not yet finished
          supabase
            .from('finishing_sends')
            .select('id', { count: 'exact', head: true })
            .neq('status', 'finishing_complete'),
          // 5. All active jobs (trajectory + priority parts)
          supabase
            .from('jobs')
            .select(`
              id, quantity, status,
              work_order:work_orders(wo_number, customer, due_date),
              component:parts!component_id(part_number),
              machine:machines!assigned_machine_id(code, name)
            `)
            .not('status', 'in', '(complete,incomplete,cancelled)'),
        ])

        if (cancelled) return

        // Trajectory bucketing
        const trajectory = { preLaunch: 0, production: 0, cruise: 0, approach: 0, splashdown: 0 }
        ;(jobsRes.data || []).forEach(j => {
          for (const [bucket, statuses] of Object.entries(STATUS_GROUPS)) {
            if (statuses.includes(j.status)) {
              trajectory[bucket]++
              break
            }
          }
        })

        // Priority parts: top 5 by quantity
        const priorityParts = (jobsRes.data || [])
          .filter(j => j.component?.part_number && (j.quantity || 0) > 0)
          .sort((a, b) => (b.quantity || 0) - (a.quantity || 0))
          .slice(0, 5)
          .map(j => ({
            part_number: j.component.part_number,
            quantity: j.quantity || 0,
            customer: j.work_order?.customer || '—',
            due_date: j.work_order?.due_date || null,
            machine_code: j.machine?.code || null,
          }))

        // Machine taxonomy: derive Down/Setup/Running/Ready/Staged/Idle per machine
        // using the shared helper so Bridge and Mainframe stay in lockstep.
        const machines = machinesRes.data || []
        const machineJobs = machineJobsRes.data || []
        const jobsByMachine = {}
        for (const j of machineJobs) {
          if (!jobsByMachine[j.assigned_machine_id]) jobsByMachine[j.assigned_machine_id] = []
          jobsByMachine[j.assigned_machine_id].push(j)
        }
        const stateCounts = { down: 0, setup: 0, running: 0, ready: 0, staged: 0, idle: 0 }
        for (const m of machines) {
          const state = deriveMachineStatus(m, jobsByMachine[m.id] || [])
          stateCounts[state]++
        }
        const machinesProducing = stateCounts.setup + stateCounts.running + stateCounts.ready + stateCounts.staged
        const machinesTotal = machines.length

        setData({
          ordersInFlight: woRes.count || 0,
          machinesProducing,
          machinesTotal,
          machinesDown: stateCounts.down,
          machinesIdle: stateCounts.idle,
          complianceQueue: complianceRes.count || 0,
          finishingQueue: finishingRes.count || 0,
          trajectory,
          priorityParts,
        })
        setLastUpdated(new Date())
      } catch (e) {
        console.error('Bridge data load error:', e)
      }
    }

    loadData()
    const id = setInterval(loadData, 60000)
    return () => { cancelled = true; clearInterval(id) }
  }, [phase])

  async function handleLogout() {
    await supabase.auth.signOut()
    navigate('/')
  }

  // --- Loading / denied states ---
  if (phase === 'auth') {
    return (
      <div style={authStyle}>ACQUIRING SIGNAL...</div>
    )
  }
  if (phase === 'denied') {
    return (
      <div style={{ ...authStyle, color: '#fbbf24', flexDirection: 'column', gap: 16 }}>
        <div>ACCESS RESTRICTED — EYES ONLY</div>
        <button
          onClick={() => navigate('/')}
          style={{
            background: 'transparent',
            border: '1px solid #fbbf24',
            color: '#fbbf24',
            padding: '8px 16px',
            cursor: 'pointer',
            fontFamily: 'monospace',
            letterSpacing: '2px',
          }}
        >
          RETURN
        </button>
      </div>
    )
  }

  // --- Computed display values ---
  const now = new Date()
  const metDays = Math.floor((now - LAUNCH_DATE) / 86400000)
  const hour = now.getHours()
  const greeting =
    hour < 12 ? 'GOOD MORNING' :
    hour < 17 ? 'GOOD AFTERNOON' :
    hour < 22 ? 'GOOD EVENING' :
    'WORKING LATE'
  const firstName = ((profile?.full_name || '').split(' ')[0] || 'COMMANDER').toUpperCase()
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000)
  const dateLine = now.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }).toUpperCase() + ` · DOY ${dayOfYear}`

  const formatDue = (iso) => iso
    ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: '2-digit' }).toUpperCase()
    : '— —'

  const formatTime = (d) => d
    ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) + ' LOCAL'
    : '——:——'

  // Static status board rows (could be data-driven later)
  const statusBoard = [
    { label: 'MANUFACTURING', state: data.trajectory.production > 0 ? 'go' : 'standby', detail: `${data.trajectory.production} JOBS` },
    { label: 'COMPLIANCE',    state: 'go',                                               detail: `${data.complianceQueue} IN QUEUE` },
    { label: 'FINISHING',     state: 'go',                                               detail: `${data.finishingQueue} BATCHES` },
    { label: 'ASSEMBLY',      state: FEATURES.ASSEMBLY_MODULE ? 'go' : 'standby',       detail: FEATURES.ASSEMBLY_MODULE ? `${data.trajectory.approach} ACTIVE` : 'OFFLINE' },
    { label: 'SCHEDULING',    state: 'go',                                               detail: 'NOMINAL' },
    { label: 'CUSTOMER ORDERS', state: 'go',                                             detail: `${data.ordersInFlight} OPEN` },
    { label: 'OUTSOURCING',   state: 'go',                                               detail: 'NOMINAL' },
    { label: 'SHIPPING',      state: 'standby',                                          detail: 'MODULE OFFLINE' },
  ]

  return (
    <>
      <style>{styles}</style>
      <div className="bridge-root">
        <div className="bridge-scanlines" />
        <div className="bridge-vignette" />

        {/* ===== Top bar ===== */}
        <header className="bridge-top">
          <div>
            <div className="bridge-title">SKYBOLT MISSION CONTROL</div>
            <div className="bridge-subtitle">PRESIDENT'S BRIDGE · LEESBURG FLIGHT OPS · EYES ONLY</div>
          </div>
          <div className="bridge-met">
            <div className="bridge-met-label">MISSION ELAPSED TIME</div>
            <div className="bridge-met-value">T+ {metDays.toLocaleString()} DAYS</div>
            <div className="bridge-met-since">SINCE LAUNCH · 23 MAR 1982</div>
          </div>
          <div className="bridge-actions">
            <button className="bridge-browse" onClick={() => navigate('/mainframe')}>BROWSE SKYNET</button>
            <button className="bridge-logout" onClick={handleLogout}>STAND DOWN</button>
          </div>
        </header>

        {/* ===== Greeting ===== */}
        <div className="bridge-greeting">
          <svg className="greeting-rocket" width="48" height="180" viewBox="0 0 48 180" fill="currentColor">
            <rect x="23" y="0" width="2" height="14" />
            <rect x="22" y="14" width="4" height="6" />
            <polygon points="20,20 28,20 30,30 18,30" />
            <rect x="19" y="30" width="10" height="20" />
            <rect x="18" y="50" width="12" height="34" />
            <polygon points="18,84 30,84 33,90 15,90" />
            <rect x="15" y="90" width="18" height="38" />
            <polygon points="15,128 33,128 37,134 11,134" />
            <rect x="11" y="134" width="26" height="32" />
            <polygon points="11,148 4,166 11,166" />
            <polygon points="37,148 44,166 37,166" />
            <polygon points="11,166 37,166 33,176 15,176" />
            <rect x="14" y="174" width="3" height="6" />
            <rect x="19" y="174" width="3" height="6" />
            <rect x="24" y="174" width="3" height="6" />
            <rect x="29" y="174" width="3" height="6" />
            <line x1="19" y1="40" x2="29" y2="40" stroke="#050a0e" strokeWidth="0.8" />
            <line x1="18" y1="60" x2="30" y2="60" stroke="#050a0e" strokeWidth="0.8" />
            <line x1="18" y1="75" x2="30" y2="75" stroke="#050a0e" strokeWidth="0.8" />
            <line x1="15" y1="100" x2="33" y2="100" stroke="#050a0e" strokeWidth="0.8" />
            <line x1="15" y1="118" x2="33" y2="118" stroke="#050a0e" strokeWidth="0.8" />
            <line x1="11" y1="142" x2="37" y2="142" stroke="#050a0e" strokeWidth="0.8" />
            <line x1="11" y1="158" x2="37" y2="158" stroke="#050a0e" strokeWidth="0.8" />
          </svg>
          <div className="greeting-text">
            <div className="greeting-line1">{greeting}, {firstName}. OPERATIONS NOMINAL.</div>
            <div className="greeting-line2">{dateLine}</div>
          </div>
        </div>

        {/* ===== KPI grid ===== */}
        <div className="kpi-grid">
          <div className="kpi-panel">
            <div className="kpi-label">
              <span className="kpi-label-text">ORDERS IN FLIGHT</span>
              <span className="kpi-station">FLIGHT</span>
            </div>
            <div className="kpi-value">{data.ordersInFlight}</div>
            <div className="kpi-meta">OPEN WORK ORDERS · ALL CUSTOMERS</div>
          </div>

          <div className="kpi-panel">
            <div className="kpi-label">
              <span className="kpi-label-text">MACHINES ACTIVE</span>
              <span className="kpi-station">GUIDANCE</span>
            </div>
            <div className="kpi-value">
              {data.machinesProducing}
              <span className="kpi-suffix">/{data.machinesTotal}</span>
            </div>
            <div className="kpi-meta">
              {data.machinesDown > 0 && (
                <>
                  <span style={{ color: 'var(--amber)' }}>{data.machinesDown} DOWN</span>
                  {' · '}
                </>
              )}
              {data.machinesIdle} IDLE · LEESBURG + TAVERES
            </div>
          </div>

          <div className="kpi-panel soon">
            <div className="kpi-label">
              <span className="kpi-label-text">ON-TIME DELIVERY</span>
              <span className="kpi-station">RETRO</span>
            </div>
            <div className="kpi-value">— —</div>
            <div className="kpi-meta">TELEMETRY ACQUIRING · COMING SOON</div>
          </div>

          <div className="kpi-panel">
            <div className="kpi-label">
              <span className="kpi-label-text">COMPLIANCE QUEUE</span>
              <span className="kpi-station">CAPCOM</span>
            </div>
            <div className="kpi-value">{data.complianceQueue}</div>
            <div className="kpi-meta">ROGER ON STATION</div>
          </div>

          <div className="kpi-panel">
            <div className="kpi-label">
              <span className="kpi-label-text">FINISHING QUEUE</span>
              <span className="kpi-station">SURGEON</span>
            </div>
            <div className="kpi-value">{data.finishingQueue}</div>
            <div className="kpi-meta">JAMES ON STATION</div>
          </div>

          <div className={'kpi-panel ' + (FEATURES.ASSEMBLY_MODULE ? '' : 'warn')}>
            <div className="kpi-label">
              <span className="kpi-label-text">ASSEMBLY ACTIVE JOBS</span>
              <span className="kpi-station">EECOM</span>
            </div>
            <div className="kpi-value">
              {FEATURES.ASSEMBLY_MODULE ? data.trajectory.approach : 'STBY'}
            </div>
            <div className="kpi-meta">
              {FEATURES.ASSEMBLY_MODULE ? 'JODY ON STATION' : 'COMING SOON · ASSEMBLY MODULE'}
            </div>
          </div>
        </div>

        {/* ===== Operations status board ===== */}
        <div className="section">
          <div className="section-header">
            <div className="section-title">OPERATIONS STATUS BOARD</div>
            <div className="section-meta">
              <span className="status-dot" />
              ALL STATIONS POLLED · {formatTime(lastUpdated)}
            </div>
          </div>
          <div className="status-grid">
            {statusBoard.map(s => (
              <div key={s.label} className={'status-row ' + s.state}>
                <span className="status-indicator">{s.state === 'go' ? 'GO' : 'STBY'}</span>
                <span className="status-label">{s.label}</span>
                <span className="status-detail">{s.detail}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ===== Priority manufacturing queue ===== */}
        <div className="section">
          <div className="section-header">
            <div className="section-title">PRIORITY MANUFACTURING QUEUE</div>
            <div className="section-meta">TOP 3 BY VOLUME · OPEN ORDERS</div>
          </div>
          <div className="priority-list">
            {data.priorityParts.length === 0 && (
              <div className="priority-empty">NO ACTIVE JOBS · STANDING BY</div>
            )}
            {data.priorityParts.map((p, i) => (
              <div key={p.part_number + '-' + i} className={'priority-row p' + (i + 1)}>
                <div className="priority-badge">P{i + 1}</div>
                <div className="priority-part">{p.part_number}</div>
                <div className="priority-qty">
                  {p.quantity.toLocaleString()}<span className="unit">PCS</span>
                </div>
                <div className="priority-meta">
                  {(p.customer || '—').toUpperCase()}
                  {' · '}
                  <span className={`priority-machine ${p.machine_code ? '' : 'unassigned'}`}>
                    {p.machine_code || '— UNASSIGNED'}
                  </span>
                  {' · DUE '}{formatDue(p.due_date)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ===== Trajectory ===== */}
        <div className="section">
          <div className="section-header">
            <div className="section-title">ORDER TRAJECTORY</div>
            <div className="section-meta">PIPELINE FLOW · LEESBURG → CUSTOMER</div>
          </div>
          <div className="trajectory">
            <svg className="trajectory-svg" viewBox="0 0 1000 180" preserveAspectRatio="none">
              <defs>
                <linearGradient id="trajGrad" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#4ade80" />
                  <stop offset="50%" stopColor="#fbbf24" />
                  <stop offset="100%" stopColor="#16a34a" />
                </linearGradient>
              </defs>
              <path
                d="M 50 150 Q 300 -20 500 80 Q 700 180 950 30"
                stroke="url(#trajGrad)"
                strokeWidth="2"
                fill="none"
                strokeDasharray="4,4"
                opacity="0.5"
              />
            </svg>
            <div className="trajectory-waypoints">
              <div className="waypoint">
                <div className="waypoint-marker" />
                <div className="waypoint-label">PRE-LAUNCH</div>
                <div className="waypoint-detail">COMPLIANCE · {data.trajectory.preLaunch}</div>
              </div>
              <div className="waypoint">
                <div className="waypoint-marker" />
                <div className="waypoint-label">PRODUCTION</div>
                <div className="waypoint-detail">MFG · {data.trajectory.production}</div>
              </div>
              <div className="waypoint">
                <div className="waypoint-marker amber" />
                <div className="waypoint-label">CRUISE</div>
                <div className="waypoint-detail">FINISHING · {data.trajectory.cruise}</div>
              </div>
              <div className="waypoint">
                <div className="waypoint-marker" />
                <div className="waypoint-label">APPROACH</div>
                <div className="waypoint-detail">ASSEMBLY · {data.trajectory.approach}</div>
              </div>
              <div className="waypoint">
                <div className="waypoint-marker" />
                <div className="waypoint-label">SPLASHDOWN</div>
                <div className="waypoint-detail">SHIPPING · {data.trajectory.splashdown}</div>
              </div>
            </div>
          </div>
        </div>

        {/* ===== Telemetry ticker ===== */}
        <div className="ticker">
          <div className="ticker-label">TELEMETRY</div>
          <div className="ticker-track">
            <div className="ticker-content">
              <span>◆ ALL STATIONS NOMINAL</span>
              <span>◆ {data.ordersInFlight} ORDERS IN FLIGHT</span>
              <span>◆ {data.complianceQueue} JOBS PENDING COMPLIANCE</span>
              <span>◆ {data.finishingQueue} BATCHES IN FINISHING</span>
              <span>◆ MISSION ELAPSED TIME T+ {metDays.toLocaleString()} DAYS</span>
              <span>◆ SKYBOLT AEROMOTIVE · LEESBURG · TAVERES · EST 1982</span>
              <span>◆ FOUNDED BY NED BOWERS · APOLLO PROGRAM ALUMNUS</span>
              <span>◆ ALL STATIONS NOMINAL</span>
            </div>
          </div>
        </div>

        {/* ===== Dedication footer ===== */}
        <footer className="bridge-footer">
          <div>
            SKYBOLT AEROMOTIVE CORP · FOUNDED 23 MARCH 1982 · NED BOWERS · PRESIDENT &amp; FOUNDER · APOLLO PROGRAM ALUMNUS
          </div>
          <div className="dedication">BUILT FOR YOU, DAD — MATT · 2026</div>
        </footer>
      </div>
    </>
  )
}

// Loading screen style (used twice)
const authStyle = {
  minHeight: '100vh',
  background: '#050a0e',
  color: '#4ade80',
  fontFamily: 'monospace',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  letterSpacing: '3px',
  fontSize: '14px',
}

// Apollo bridge styling — see /home/claude/skybolt_bridge_mockup.html for design rationale
const styles = `
@import url('https://fonts.googleapis.com/css2?family=Black+Ops+One&family=JetBrains+Mono:wght@300;400;500;700&family=Major+Mono+Display&display=swap');

.bridge-root {
  --bg: #050a0e;
  --panel-bg: #0a1419;
  --phosphor: #4ade80;
  --phosphor-glow: rgba(74, 222, 128, 0.45);
  --phosphor-dim: #16a34a;
  --amber: #fbbf24;
  --amber-glow: rgba(251, 191, 36, 0.45);
  --white: #f1f5f9;
  --muted: #94a3b8;

  position: relative;
  min-height: 100vh;
  background:
    radial-gradient(ellipse at center, rgba(74, 222, 128, 0.02) 0%, transparent 70%),
    linear-gradient(to bottom, var(--bg), #02060a);
  background-attachment: fixed;
  color: var(--phosphor);
  font-family: 'JetBrains Mono', monospace;
  padding: 24px 32px 32px;
  overflow-x: hidden;
}
.bridge-root::before {
  content: '';
  position: fixed;
  inset: 0;
  background-image:
    linear-gradient(rgba(74, 222, 128, 0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(74, 222, 128, 0.025) 1px, transparent 1px);
  background-size: 40px 40px;
  pointer-events: none;
  z-index: 1;
}
.bridge-scanlines {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 1000;
  background: repeating-linear-gradient(
    to bottom,
    transparent 0,
    transparent 2px,
    rgba(0, 0, 0, 0.12) 2px,
    rgba(0, 0, 0, 0.12) 3px
  );
  mix-blend-mode: multiply;
}
.bridge-vignette {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 999;
  background: radial-gradient(ellipse at center, transparent 30%, rgba(0, 0, 0, 0.5) 100%);
}

/* ===== Top bar ===== */
.bridge-top {
  position: relative;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 20px;
  border-bottom: 1px solid rgba(74, 222, 128, 0.18);
  margin-bottom: 28px;
  gap: 24px;
}
.bridge-title {
  font-family: 'Black Ops One', cursive;
  font-size: 22px;
  color: var(--white);
  letter-spacing: 4px;
  text-shadow: 0 0 8px rgba(241, 245, 249, 0.4);
}
.bridge-subtitle {
  font-size: 10px;
  color: var(--muted);
  letter-spacing: 3px;
  margin-top: 4px;
}
.bridge-met { text-align: right; }
.bridge-met-label {
  font-size: 9px;
  color: var(--muted);
  letter-spacing: 2px;
}
.bridge-met-value {
  font-family: 'Major Mono Display', monospace;
  font-size: 22px;
  color: var(--amber);
  letter-spacing: 2px;
  text-shadow: 0 0 8px var(--amber-glow);
  margin: 2px 0;
}
.bridge-met-since {
  font-size: 9px;
  color: var(--phosphor-dim);
  letter-spacing: 2px;
}
.bridge-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.bridge-browse {
  background: transparent;
  border: 1px solid rgba(74, 222, 128, 0.4);
  color: var(--phosphor);
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 2px;
  padding: 8px 14px;
  cursor: pointer;
  transition: all 0.2s;
}
.bridge-browse:hover {
  background: rgba(74, 222, 128, 0.08);
  text-shadow: 0 0 6px var(--phosphor-glow);
}
.bridge-logout {
  background: transparent;
  border: 1px solid rgba(251, 191, 36, 0.4);
  color: var(--amber);
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 2px;
  padding: 8px 14px;
  cursor: pointer;
  transition: all 0.2s;
}
.bridge-logout:hover {
  background: rgba(251, 191, 36, 0.08);
  text-shadow: 0 0 4px var(--amber-glow);
}

/* ===== Greeting ===== */
.bridge-greeting {
  position: relative;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 32px;
  padding: 24px 28px;
  background: rgba(10, 20, 25, 0.7);
  border: 1px solid rgba(74, 222, 128, 0.15);
  margin-bottom: 28px;
}
.greeting-rocket {
  color: var(--white);
  flex-shrink: 0;
  opacity: 0.85;
  filter: drop-shadow(0 0 4px rgba(241, 245, 249, 0.3));
}
.greeting-line1 {
  font-family: 'Black Ops One', cursive;
  font-size: 26px;
  color: var(--white);
  letter-spacing: 3px;
  text-shadow: 0 0 6px rgba(241, 245, 249, 0.3);
}
.greeting-line2 {
  font-size: 11px;
  color: var(--phosphor);
  letter-spacing: 2.5px;
  margin-top: 8px;
  text-shadow: 0 0 4px var(--phosphor-glow);
}

/* ===== KPI grid ===== */
.kpi-grid {
  position: relative;
  z-index: 10;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-bottom: 28px;
}
.kpi-panel {
  position: relative;
  background: rgba(10, 20, 25, 0.75);
  border: 1px solid rgba(74, 222, 128, 0.15);
  padding: 18px 20px;
  overflow: hidden;
}
.kpi-panel::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: var(--phosphor);
  box-shadow: 0 0 6px var(--phosphor-glow);
}
.kpi-panel.warn::before {
  background: var(--amber);
  box-shadow: 0 0 6px var(--amber-glow);
}
.kpi-panel.soon::before {
  background: transparent;
  border-top: 1px dashed var(--phosphor-dim);
  box-shadow: none;
  height: 1px;
}
.kpi-panel.soon .kpi-value {
  color: var(--phosphor-dim);
  text-shadow: none;
  font-size: 48px;
  letter-spacing: 8px;
}
.kpi-panel.soon .kpi-station {
  color: var(--muted);
  border-color: var(--muted);
  background: transparent;
}
.kpi-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.kpi-label-text {
  font-size: 10px;
  color: var(--muted);
  letter-spacing: 2.5px;
}
.kpi-station {
  font-size: 8px;
  color: var(--phosphor);
  letter-spacing: 1.5px;
  padding: 2px 6px;
  border: 1px solid rgba(74, 222, 128, 0.3);
  background: rgba(74, 222, 128, 0.05);
}
.kpi-panel.warn .kpi-station {
  color: var(--amber);
  border-color: rgba(251, 191, 36, 0.3);
  background: rgba(251, 191, 36, 0.05);
}
.kpi-value {
  font-family: 'Major Mono Display', monospace;
  font-size: 56px;
  color: var(--phosphor);
  text-shadow: 0 0 12px var(--phosphor-glow);
  line-height: 1;
}
.kpi-panel.warn .kpi-value {
  color: var(--amber);
  text-shadow: 0 0 12px var(--amber-glow);
  font-size: 48px;
  letter-spacing: 8px;
}
.kpi-suffix {
  font-size: 24px;
  color: var(--muted);
  text-shadow: none;
  margin-left: 4px;
}
.kpi-meta {
  font-size: 10px;
  color: var(--muted);
  letter-spacing: 1.5px;
  margin-top: 12px;
}

/* ===== Sections ===== */
.section {
  position: relative;
  z-index: 10;
  margin-bottom: 28px;
}
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 12px;
  margin-bottom: 16px;
  border-bottom: 1px solid rgba(74, 222, 128, 0.15);
}
.section-title {
  font-family: 'Black Ops One', cursive;
  font-size: 14px;
  color: var(--phosphor);
  letter-spacing: 3px;
  text-shadow: 0 0 4px var(--phosphor-glow);
}
.section-meta {
  font-size: 10px;
  color: var(--muted);
  letter-spacing: 2px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  background: var(--phosphor);
  border-radius: 50%;
  box-shadow: 0 0 8px var(--phosphor-glow);
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* ===== Status board ===== */
.status-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.status-row {
  display: grid;
  grid-template-columns: 70px 1fr auto;
  align-items: center;
  gap: 16px;
  padding: 10px 14px;
  background: rgba(10, 20, 25, 0.5);
  border-left: 2px solid var(--phosphor);
}
.status-row.standby { border-left-color: var(--amber); }
.status-indicator {
  font-family: 'Black Ops One', cursive;
  font-size: 11px;
  color: var(--phosphor);
  letter-spacing: 2px;
  text-align: center;
  text-shadow: 0 0 4px var(--phosphor-glow);
}
.status-row.standby .status-indicator {
  color: var(--amber);
  text-shadow: 0 0 4px var(--amber-glow);
}
.status-label {
  font-size: 11px;
  color: var(--white);
  letter-spacing: 2px;
}
.status-detail {
  font-size: 9px;
  color: var(--muted);
  letter-spacing: 1.5px;
}

/* ===== Priority queue ===== */
.priority-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.priority-row {
  display: grid;
  grid-template-columns: 56px 1fr auto auto;
  align-items: center;
  gap: 20px;
  padding: 14px 18px;
  background: rgba(10, 20, 25, 0.7);
  border-left: 2px solid var(--amber);
}
.priority-row.p2 { border-left-color: var(--phosphor); }
.priority-row.p3 { border-left-color: var(--phosphor-dim); }
.priority-badge {
  font-family: 'Black Ops One', cursive;
  font-size: 13px;
  color: var(--amber);
  letter-spacing: 2px;
  text-align: center;
  padding: 6px 0;
  border: 1px solid var(--amber);
  background: rgba(251, 191, 36, 0.08);
  text-shadow: 0 0 4px var(--amber-glow);
}
.priority-row.p2 .priority-badge {
  color: var(--phosphor);
  border-color: var(--phosphor);
  background: rgba(74, 222, 128, 0.08);
  text-shadow: 0 0 4px var(--phosphor-glow);
}
.priority-row.p3 .priority-badge {
  color: var(--phosphor-dim);
  border-color: var(--phosphor-dim);
  background: transparent;
  text-shadow: none;
}
.priority-part {
  font-family: 'Major Mono Display', monospace;
  font-size: 22px;
  color: var(--white);
  letter-spacing: 2px;
  text-shadow: 0 0 4px rgba(241, 245, 249, 0.25);
}
.priority-qty {
  font-family: 'Major Mono Display', monospace;
  font-size: 22px;
  color: var(--phosphor);
  text-shadow: 0 0 8px var(--phosphor-glow);
  text-align: right;
  letter-spacing: 1px;
}
.priority-qty .unit {
  font-size: 10px;
  color: var(--muted);
  margin-left: 8px;
  font-family: 'JetBrains Mono', monospace;
  letter-spacing: 1.5px;
  text-shadow: none;
}
.priority-meta {
  font-size: 10.5px;
  color: var(--muted);
  letter-spacing: 1.5px;
  min-width: 180px;
  text-align: right;
}
.priority-machine {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  letter-spacing: 2px;
  color: var(--phosphor-dim);
}
.priority-machine.unassigned {
  color: var(--amber);
}
.priority-empty {
  padding: 24px;
  text-align: center;
  color: var(--muted);
  font-size: 11px;
  letter-spacing: 2px;
  background: rgba(10, 20, 25, 0.5);
}

/* ===== Trajectory ===== */
.trajectory {
  position: relative;
  height: 180px;
  background: rgba(10, 20, 25, 0.5);
  padding: 20px;
}
.trajectory-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.trajectory-waypoints {
  position: relative;
  height: 100%;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  align-items: end;
}
.waypoint {
  text-align: center;
  position: relative;
}
.waypoint-marker {
  width: 12px;
  height: 12px;
  border: 2px solid var(--phosphor);
  background: var(--bg);
  border-radius: 50%;
  margin: 0 auto 8px;
  box-shadow: 0 0 8px var(--phosphor-glow);
}
.waypoint-marker.amber {
  border-color: var(--amber);
  box-shadow: 0 0 8px var(--amber-glow);
}
.waypoint-label {
  font-family: 'Black Ops One', cursive;
  font-size: 10px;
  color: var(--white);
  letter-spacing: 2px;
}
.waypoint-detail {
  font-size: 9px;
  color: var(--muted);
  letter-spacing: 1.5px;
  margin-top: 2px;
}

/* ===== Ticker ===== */
.ticker {
  position: relative;
  z-index: 10;
  display: flex;
  align-items: center;
  background: rgba(10, 20, 25, 0.85);
  border: 1px solid rgba(74, 222, 128, 0.18);
  height: 36px;
  overflow: hidden;
  margin-bottom: 28px;
}
.ticker-label {
  flex-shrink: 0;
  padding: 0 14px;
  height: 100%;
  display: flex;
  align-items: center;
  background: rgba(74, 222, 128, 0.1);
  border-right: 1px solid rgba(74, 222, 128, 0.18);
  font-family: 'Black Ops One', cursive;
  font-size: 10px;
  color: var(--amber);
  letter-spacing: 2px;
  text-shadow: 0 0 4px var(--amber-glow);
}
.ticker-track {
  flex: 1;
  overflow: hidden;
  position: relative;
}
.ticker-content {
  display: flex;
  gap: 48px;
  white-space: nowrap;
  animation: scroll-ticker 75s linear infinite;
  font-size: 11px;
  letter-spacing: 1.5px;
  color: var(--phosphor);
  align-items: center;
  height: 36px;
  padding-left: 100%;
}
@keyframes scroll-ticker {
  0% { transform: translateX(0); }
  100% { transform: translateX(-130%); }
}

/* ===== Footer ===== */
.bridge-footer {
  position: relative;
  z-index: 10;
  padding-top: 16px;
  border-top: 1px solid rgba(74, 222, 128, 0.12);
  text-align: center;
  font-size: 9px;
  color: var(--muted);
  letter-spacing: 2.5px;
  line-height: 1.8;
}
.dedication {
  color: var(--phosphor-dim);
  letter-spacing: 3px;
  font-style: italic;
  margin-top: 8px;
}
`
