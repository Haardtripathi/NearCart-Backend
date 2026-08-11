/**
 * STRETCH TEST — left `.skip()`'d. Not completed in the time available for this task; documented
 * here in detail so it's straightforward to pick up later rather than silently omitted.
 *
 * Goal: exercise the REAL marketplace bridge (not the mock used by every other spec file in this
 * suite) end to end — start a second, real `NearCart-Inventory/backend` Express app in-process,
 * point this repo's inventory-client.service.ts at it, drive a full customer checkout through
 * `POST /orders`, and assert a `SalesOrder` actually landed on the Inventory side with the exact
 * payload shape `syncOrderToInventoryBridge` (orders.service.ts) sends — including making the
 * known gap explicit: no shop coordinates and no delivery fee are part of that payload today (see
 * `PushSalesOrderInput` in inventory-client.service.ts: `customer: { name, phone, addressLine,
 * latitude, longitude }` carries the CUSTOMER's coordinates, and `items` carries
 * unitPrice/quantity — but nothing about the shop's own location or the computed `deliveryFee`
 * crosses the bridge at all).
 *
 * Concrete plan for whoever picks this up:
 *
 * 1. In `beforeAll`, before importing this repo's `app`:
 *    - Set `process.env.INVENTORY_SERVICE_URL` / `process.env.INVENTORY_INTERNAL_TOKEN` (this
 *      repo's env.ts reads `INVENTORY_API_BASE_URL` first, then `INVENTORY_SERVICE_URL` — see
 *      `src/config/env.ts`) to point at the second app once its port is known.
 *    - DO NOT let this touch the shared `tests/test.db` used by every other spec file — the
 *      Inventory app needs its OWN separate disposable `file:` DB (its schema is completely
 *      different). Something like `file:./tests/test-inventory-sibling.db`, pushed via the same
 *      `prisma db push --accept-data-loss` pattern `tests/global-setup.ts` uses for this repo,
 *      but run against `NearCart-Inventory/backend/prisma/schema.prisma` with its own env
 *      override, and cleaned up in `afterAll`.
 *
 * 2. Import and boot the sibling app:
 *      import { app as inventoryApp } from '/home/kakarot/Projects/NearCart-App/NearCart-Inventory/backend/src/app'
 *      // NOTE: named export `app`, NOT a default export — different from this repo's own
 *      // `src/app.ts`, which the reset needed to be found first (see `tests/helpers/fixtures.ts`
 *      // for the pattern this repo uses instead).
 *    That repo's `src/config/env.ts` uses a strict zod schema (`envSchema.parse`) that throws at
 *    import time if required vars are missing — at minimum it needs real-looking values for
 *    `DATABASE_URL`, `JWT_SECRET`, and `ADMIN_BOOTSTRAP_SECRET` (all required, no defaults — see
 *    that repo's `src/config/env.ts`) before `app.ts` (or anything importing it) can even be
 *    imported. `MARKETPLACE_INTERNAL_TOKEN` should be set to the SAME value this repo's
 *    `INVENTORY_INTERNAL_TOKEN` will be set to, so `requireInternalServiceAuth` on the Inventory
 *    side accepts this repo's bridge calls.
 *    Start it with `const server = inventoryApp.listen(0)`, read the real bound port off
 *    `server.address()`, and set `INVENTORY_SERVICE_URL=http://127.0.0.1:<port>` before this
 *    repo's own `src/app.ts` / `inventory-client.service.ts` get imported (same "env before
 *    import" ordering constraint `tests/setup.ts` already documents for this repo's own env).
 *
 * 3. On the Inventory side, an organization + branch need to exist for the SalesOrder to be
 *    created against (see `src/modules/marketplace/marketplace.route.ts`'s
 *    `POST /organizations/:organizationId/sales-orders`) — that likely means driving its own
 *    admin/org-setup flow the same way `tests/helpers/fixtures.ts` drives THIS repo's
 *    register->approve->map flow, or seeding directly with that repo's own Prisma client if
 *    that's more practical. Whichever org/branch id comes out of that setup is what this repo's
 *    `Shop.inventoryOrganizationId`/`inventoryBranchId` (set via
 *    `PATCH /api/admin/shops/:shopId/storefront` — see `tests/helpers/fixtures.ts`) must match.
 *
 * 4. Drive a real checkout through THIS repo's `POST /orders` (same as
 *    `checkout-fee-parity.spec.ts`, but with `inventory-client.service.ts` UNMOCKED this time —
 *    do not import `tests/helpers/inventory-mock-factory.ts` / call `vi.mock(...)` in this file).
 *
 * 5. Assert: query the Inventory app's own Prisma client (or hit one of its own read endpoints)
 *    for a `SalesOrder` with `externalOrderId` equal to this repo's newly created `Order.id`, and
 *    assert on its stored fields — particularly confirming there's no shop-coordinates/
 *    delivery-fee field anywhere on it, making the documented gap an active regression test
 *    instead of just a comment.
 *
 * 6. `afterAll`: close the Inventory app's `server`, delete its separate test DB file(s), same
 *    pattern as `tests/global-setup.ts`.
 *
 * Why this was left unimplemented rather than attempted partially: steps 1-3 alone are a second
 * full test-infrastructure build-out (separate env/schema/DB-lifecycle/org-setup, all in a
 * different repo with its own zod-validated env and no test infra of its own either) — enough
 * scope on its own that attempting it partially in the remaining time would likely produce a
 * flaky, half-working test that's worse than an honest `.skip()`.
 */
import { describe, it } from 'vitest'

describe.skip('cross-backend order sync (real NearCart-Inventory bridge, not mocked)', () => {
  it('pushes a real SalesOrder into NearCart-Inventory on checkout, with the documented payload gaps', () => {
    // See the file-level comment above for the intended implementation.
  })
})
