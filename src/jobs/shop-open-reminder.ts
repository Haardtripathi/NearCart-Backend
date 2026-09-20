import { schedule } from 'node-cron'

import { sendShopOpenReminders } from '../services/shop-open-reminder.service'

/**
 * Guards against overlapping ticks — node-cron fires on the wall clock whether or not the
 * previous run finished, and a slow tick (many shops, a sluggish bridge) would otherwise have a
 * second run select the same shops and race it.
 */
let reminderInFlight = false

/**
 * Nudges shops that haven't confirmed they're open today — see
 * `services/shop-open-reminder.service.ts` for why this exists (an owner who forgets gets zero
 * orders all day with no explanation).
 *
 * Hourly from 06:00 to 11:00 India time, rather than once at a fixed hour: shops open at very
 * different times, a single 07:00 nudge is useless to someone who opens at 10:00, and the
 * once-per-shop-per-day claim in the service means the later ticks are a no-op for anyone who has
 * already confirmed. It stops at 11:00 so a shop that is genuinely closed today isn't pestered
 * all afternoon.
 */
export function registerShopOpenReminder(): void {
  schedule(
    '0 6-11 * * *',
    () => {
      if (reminderInFlight) {
        console.warn('[shop-open-reminder] Previous tick still running — skipping this one.')
        return
      }

      reminderInFlight = true

      sendShopOpenReminders()
        .then(({ considered, reminded }) => {
          if (reminded > 0) {
            console.log(`[shop-open-reminder] Reminded ${reminded} of ${considered} unconfirmed shop(s).`)
          }
        })
        // Defense in depth on top of the service's own per-shop try/catch — a scheduled job must
        // never be able to produce an unhandled rejection that takes the process down.
        .catch((error) => {
          console.warn('[shop-open-reminder] Unexpected error during tick', error)
        })
        .finally(() => {
          reminderInFlight = false
        })
    },
    { timezone: 'Asia/Kolkata' },
  )

  console.log('[shop-open-reminder] Registered (hourly, 06:00-11:00 IST).')
}
