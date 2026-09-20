import { schedule } from 'node-cron'

import { reconcileFailedInventorySyncs } from '../services/orders.service'

/**
 * Registers a periodic retry for orders stuck at `inventorySyncStatus: 'FAILED'` — see
 * `reconcileFailedInventorySyncs` in orders.service.ts for the full rationale. Runs every 5
 * minutes (looser than NearCart-Inventory's every-minute confirmation-deadline sweep since this
 * is best-effort reconciliation, not a customer-facing SLA) and is safe to call repeatedly: each
 * tick only touches orders still in a FAILED state, so a successful retry naturally drops out of
 * the next tick's query.
 */
export function registerInventorySyncRetrySweep(): void {
  schedule('*/5 * * * *', () => {
    // Defense in depth on top of reconcileFailedInventorySyncs's own internal try/catch blocks —
    // a scheduled job must never be able to produce an unhandled rejection that takes the whole
    // process down with it (this exact bug class was previously found and fixed in
    // NearCart-Inventory's order-confirmation-sweep).
    reconcileFailedInventorySyncs().catch((error) => {
      console.warn('[inventory-sync-retry] Unexpected error during sweep tick', error)
    })
  })

  console.log('[inventory-sync-retry] Registered (runs every 5 minutes).')
}
