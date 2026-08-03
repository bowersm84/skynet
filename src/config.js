//
// SkyNet feature flags. Edit this file to enable or disable major
// system capabilities. Changes require a commit + Amplify deploy.
//
// History:
//   2026-05-04  Assembly module hidden for go-live (Matt)
//   YYYY-MM-DD  Assembly module enabled — Jody trained (TBD)
//

export const FEATURES = {
  /**
   * Assembly module — enables Jody's per-WOA assembly workflow,
   * including ALN entry, mid-assembly batch sending, and post-assembly
   * outsourcing via Jody's controls.
   *
   * When false:
   *  - Assembly nav entry is hidden from Mainframe
   *  - Assembly KPI tile hidden
   *  - Components route directly to pending_tco after their external work
   *    (instead of ready_for_assembly)
   *  - Post-assembly outsourcing batches auto-created when components complete,
   *    so Ashley can ship paint/HT without Jody being involved
   *  - Ashley enters ALN at send-out time (instead of Jody at Start Assembly)
   *
   * When true: full S6 assembly behavior — Jody starts assemblies,
   * sends batches, completes them, etc.
   *
   * For go-live: false. Flip to true when Jody is trained and ready.
   */
  ASSEMBLY_MODULE: false,

  /**
   * Raw Material Checkout Kiosk — rack staging device + material finalize on
   * completion paths. When false: the MaterialKiosk route is hidden and no
   * new material-kiosk UI renders. The existing in-kiosk material step and the
   * June-3 start-lot gate are UNAFFECTED by this flag.
   * Pilot: flip true for the one material area only.
   */
  MATERIAL_KIOSK: true,

  /**
   * Nested Assembly (assembly-within-assembly). When false: Create WO renders
   * the existing single-level BOM list and submits flat — no behavior change.
   * When true: Create WO loads the full BOM tree via explode_bom and renders it
   * as an expandable tree (sub-assembly groups, manufactured-leaf job toggles).
   * Layered on ASSEMBLY_MODULE — only meaningful once assembly is live.
   * Batch B1: tree UI + selection (no submit). Batch B2: recursive submit.
   * Keep false in PROD; flip true on TEST for nested-assembly testing.
   */
  NESTED_ASSEMBLY: true,

  /**
   * Kit & STC Registry — the serialized kit-lot / aircraft / STC paperwork
   * module at /kits (kiosk-style, outside MainApp; NOT a Mainframe tab).
   *
   * When false:
   *  - the /kits route renders a "not enabled" card and nothing else;
   *    no kit entry, no search, no STC surface is reachable
   *  - Mainframe is unaffected either way — this module adds nothing to it
   *
   * When true: Kit Entry (warehouse bench, dual-mode auth — office session or
   * kiosk JWT + per-save PIN), plus the Search / Log STC areas as they land.
   *
   * TEST: true. The PROD merge decision is made at promotion time, once the
   * paper-book dual-run has been walked at the bench.
   */
  KIT_STC_REGISTRY: true,

  /**
   * Kit & STC Registry — exception-queue baseline. ISO date string
   * ('YYYY-MM-DD') or null.
   *
   * The global dashboard's five exception queues only count items whose
   * anchor date falls on or after this date — request received_date for the
   * intake queues, lot log_date for the lot queues, and (for the no-BOM
   * queue) a SKU referenced by at least one post-baseline lot. null shows
   * all history.
   *
   * This is a DISPLAY LENS over live-derived queues. No data is written,
   * altered, or hidden: Search, the entity lenses, and every detail drawer
   * always show full truth regardless of this setting. Cards carry a
   * "since {date}" suffix whenever it is set, so the dashboard never reads
   * as more complete than it is.
   *
   * To change it: edit here, commit, deploy.
   */
  KIT_EXCEPTIONS_SINCE: '2026-08-03',
}