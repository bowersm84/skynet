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
}
