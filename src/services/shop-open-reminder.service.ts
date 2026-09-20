import prisma from '../lib/prisma'
import { kvSetNx } from '../lib/kvStore'
import { sendInventoryShopOpenReminder } from './inventory-client.service'
import { PUBLIC_SHOP_WHERE } from './public-storefront.service'

/**
 * Daily nudge to shops that haven't confirmed they're open today.
 *
 * `utils/shop-availability.ts` blocks cart-validate and checkout for any shop whose owner hasn't
 * confirmed "we're open" for the current India-local day. That's deliberate — it stops customers
 * ordering from a shop that never opened — but it has a sharp edge: an owner who simply forgets
 * gets zero orders all day, sees nothing wrong in their own app, and has no idea why. This closes
 * that loop.
 *
 * The sweep runs on THIS side because this is where the flag lives, so "which shops are
 * unconfirmed" is one indexed query rather than a question asked of every organization in turn.
 * The push itself is sent by NearCart-Inventory (the Partner app talks only to that backend, so
 * the staff device tokens are there), via the internal marketplace bridge.
 */

const SHOP_LOCAL_TIME_ZONE = 'Asia/Kolkata'

/** Cap per tick. Bounds both the outbound bridge calls and the work one tick can do, the same
 *  reasoning as the sweeps on the Inventory side. */
const REMINDER_BATCH_SIZE = 200

/** How many bridge calls may be in flight at once. Each is a real HTTP round trip to the other
 *  backend; firing all 200 at once would spike it far harder than a customer ever does. */
const REMINDER_CONCURRENCY = 5

function shopLocalDayKey(date: Date): string {
  // en-CA formats as YYYY-MM-DD, matching utils/shop-availability.ts's own day key so the two
  // agree on where "today" starts.
  return date.toLocaleDateString('en-CA', { timeZone: SHOP_LOCAL_TIME_ZONE })
}

/**
 * The instant the current India-local day began, as a UTC `Date`, so the unconfirmed check can be
 * a plain indexed `todayStatusUpdatedAt < startOfDay` comparison in SQL rather than reading every
 * shop and comparing day keys in JS.
 */
function startOfShopLocalDay(now: Date): Date {
  const dayKey = shopLocalDayKey(now)
  // IST is a fixed +05:30 with no DST, so the local midnight is unambiguous.
  return new Date(`${dayKey}T00:00:00+05:30`)
}

async function remindOneShop(shop: {
  id: string
  name: string
  inventoryOrganizationId: string | null
}, dayKey: string): Promise<boolean> {
  if (!shop.inventoryOrganizationId) {
    return false
  }

  // Once per shop per local day, whoever gets there first. `kvSetNx` is the same primitive the
  // coupon and refresh-token paths use, so with Redis configured this holds across instances;
  // without it, it still de-duplicates within this process. A reminder is not worth a second
  // round trip to verify, so a duplicate on a multi-instance deploy with no Redis is acceptable —
  // a MISSED reminder is the failure that matters, and the key is only written after a send.
  const claimed = await kvSetNx(
    `shop-open-reminder:${shop.id}:${dayKey}`,
    '1',
    20 * 60 * 60,
  )

  if (!claimed) {
    return false
  }

  await sendInventoryShopOpenReminder({ organizationId: shop.inventoryOrganizationId })
  return true
}

/**
 * Finds every listed shop that hasn't confirmed today and asks its back office to nudge the
 * staff. Never throws: a shop whose bridge call fails is skipped and retried on the next tick,
 * because a reminder that fails must not stop the rest of the batch going out.
 */
async function sendShopOpenReminders(): Promise<{ considered: number; reminded: number }> {
  const now = new Date()
  const startOfToday = startOfShopLocalDay(now)
  const dayKey = shopLocalDayKey(now)

  const shops = await prisma.shop.findMany({
    where: {
      ...PUBLIC_SHOP_WHERE,
      inventoryOrganizationId: { not: null },
      OR: [
        { todayStatusUpdatedAt: null },
        { todayStatusUpdatedAt: { lt: startOfToday } },
      ],
    },
    select: { id: true, name: true, inventoryOrganizationId: true },
    take: REMINDER_BATCH_SIZE,
  })

  let reminded = 0
  const queue = [...shops]

  const workers = Array.from({ length: Math.min(REMINDER_CONCURRENCY, queue.length) }, async () => {
    for (let shop = queue.shift(); shop; shop = queue.shift()) {
      try {
        if (await remindOneShop(shop, dayKey)) {
          reminded += 1
        }
      } catch (error) {
        console.warn(
          `[shop-open-reminder] Could not remind ${shop.name} (${shop.id})`,
          error instanceof Error ? error.message : error,
        )
      }
    }
  })

  await Promise.all(workers)

  return { considered: shops.length, reminded }
}

export { sendShopOpenReminders }
