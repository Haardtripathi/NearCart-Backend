/**
 * Internal (service-to-service) shop "open today" endpoints — the path NearCart-Inventory's
 * Partner app uses to flip a shop open/closed, addressing it by the Inventory org/branch it's
 * linked to (`GET/PATCH /api/internal/shops/today-status`, see
 * `src/services/internal-shop-status.service.ts`).
 *
 * The org/branch link is written straight to the (disposable, `file:`-guarded — see
 * tests/setup.ts) test DB rather than through the admin storefront endpoint: nothing here is
 * about admin flows, and it keeps this spec free of any admin login.
 */
import { randomUUID } from 'node:crypto'

import request from 'supertest'
import { describe, expect, it } from 'vitest'

import app from '../../src/app'
import env from '../../src/config/env'
import prisma from '../../src/lib/prisma'

const TOKEN_HEADER = 'x-internal-service-token'
const PATH = '/api/internal/shops/today-status'

async function createLinkedShop(organizationId: string, branchId: string | null) {
  const registerResponse = await request(app)
    .post('/api/auth/register/shop-owner')
    .send({
      fullName: 'Today Status Owner',
      email: `today-status-${randomUUID()}@test.nearcart.local`,
      password: 'TestPassword123!',
      businessName: `Today Status Business ${randomUUID()}`,
    })
  expect(registerResponse.status).toBe(201)
  const ownerAccessToken = registerResponse.body.accessToken as string

  const createShopResponse = await request(app)
    .post('/api/shop-owner/shops')
    .set('Authorization', `Bearer ${ownerAccessToken}`)
    .send({
      name: `Today Status Shop ${randomUUID()}`,
      category: 'Grocery',
      phone: '9999999999',
      addressLine1: '1 Status Street',
      city: 'Test City',
      pincode: '110001',
    })
  expect(createShopResponse.status).toBe(201)
  const shopId = createShopResponse.body.item.id as string

  await prisma.shop.update({
    where: { id: shopId },
    data: { inventoryOrganizationId: organizationId, inventoryBranchId: branchId },
  })

  return { shopId, ownerAccessToken }
}

describe('internal shop today-status endpoints', () => {
  it('rejects calls without the internal service token', async () => {
    const getResponse = await request(app).get(PATH).query({ organizationId: 'any-org' })
    expect(getResponse.status).toBe(403)

    const patchResponse = await request(app)
      .patch(PATH)
      .set(TOKEN_HEADER, 'definitely-not-the-token')
      .send({ organizationId: 'any-org', isOpen: true })
    expect(patchResponse.status).toBe(403)
  })

  it('walks a linked shop PENDING_CONFIRMATION -> OPEN -> CLOSED(reason) -> OPEN(reason cleared)', async () => {
    const organizationId = `org-${randomUUID()}`
    const branchId = `branch-${randomUUID()}`
    const { shopId, ownerAccessToken } = await createLinkedShop(organizationId, branchId)

    const initial = await request(app)
      .get(PATH)
      .set(TOKEN_HEADER, env.inventoryInternalToken)
      .query({ organizationId })
    expect(initial.status).toBe(200)
    expect(initial.body.items).toHaveLength(1)
    expect(initial.body.items[0]).toMatchObject({
      shopId,
      inventoryBranchId: branchId,
      todayStatus: 'PENDING_CONFIRMATION',
      isOpenToday: null,
      todayStatusReason: null,
      todayStatusUpdatedAt: null,
    })
    expect(Object.keys(initial.body.items[0]).sort()).toEqual(
      [
        'inventoryBranchId',
        'isOpenToday',
        'name',
        'shopId',
        'slug',
        'todayStatus',
        'todayStatusReason',
        'todayStatusUpdatedAt',
      ].sort(),
    )

    const opened = await request(app)
      .patch(PATH)
      .set(TOKEN_HEADER, env.inventoryInternalToken)
      .send({ organizationId, branchId, isOpen: true, reason: 'ignored when opening' })
    expect(opened.status).toBe(200)
    expect(opened.body.items[0]).toMatchObject({
      shopId,
      todayStatus: 'OPEN',
      isOpenToday: true,
      todayStatusReason: null,
    })
    expect(opened.body.items[0].todayStatusUpdatedAt).toBeTruthy()

    const closed = await request(app)
      .patch(PATH)
      .set('Authorization', `Bearer ${env.inventoryInternalToken}`)
      .send({ organizationId, isOpen: false, reason: '  Holiday  ' })
    expect(closed.status).toBe(200)
    expect(closed.body.items[0]).toMatchObject({
      todayStatus: 'CLOSED',
      isOpenToday: false,
      todayStatusReason: 'Holiday',
    })

    // The shop owner's own (web) view reads the very same columns — both entry points agree.
    const ownerView = await request(app)
      .get(`/api/shop-owner/shops/${shopId}`)
      .set('Authorization', `Bearer ${ownerAccessToken}`)
    expect(ownerView.status).toBe(200)

    const reopened = await request(app)
      .patch(PATH)
      .set(TOKEN_HEADER, env.inventoryInternalToken)
      .send({ organizationId, isOpen: true })
    expect(reopened.body.items[0]).toMatchObject({ todayStatus: 'OPEN', todayStatusReason: null })

    const row = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })
    expect(row.isOpenToday).toBe(true)
    expect(row.todayStatusReason).toBeNull()
  })

  it('returns 404 on PATCH (and an empty list on GET) when the org has no linked shop', async () => {
    const organizationId = `org-unlinked-${randomUUID()}`

    const list = await request(app)
      .get(PATH)
      .set(TOKEN_HEADER, env.inventoryInternalToken)
      .query({ organizationId })
    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([])

    const patch = await request(app)
      .patch(PATH)
      .set(TOKEN_HEADER, env.inventoryInternalToken)
      .send({ organizationId, isOpen: true })
    expect(patch.status).toBe(404)
    expect(patch.body.message).toMatch(/no nearcart shop is linked/i)
    // NearCart-Inventory's proxy keys off this code to tell "not listed" apart from a bare
    // unknown-route 404 (an older NearCart build) — it's part of the contract.
    expect(patch.body.details).toMatchObject({ code: 'SHOP_NOT_LINKED' })
  })

  it('narrows by branch: another branch is untouched, an org-wide (no-branch) shop is included', async () => {
    const organizationId = `org-${randomUUID()}`
    const branchA = `branch-a-${randomUUID()}`
    const branchB = `branch-b-${randomUUID()}`
    const shopA = await createLinkedShop(organizationId, branchA)
    const shopB = await createLinkedShop(organizationId, branchB)
    const shopOrgWide = await createLinkedShop(organizationId, null)

    const patch = await request(app)
      .patch(PATH)
      .set(TOKEN_HEADER, env.inventoryInternalToken)
      .send({ organizationId, branchId: branchA, isOpen: true })
    expect(patch.status).toBe(200)
    expect((patch.body.items as Array<{ shopId: string }>).map((item) => item.shopId).sort()).toEqual(
      [shopA.shopId, shopOrgWide.shopId].sort(),
    )

    const all = await request(app)
      .get(PATH)
      .set(TOKEN_HEADER, env.inventoryInternalToken)
      .query({ organizationId })
    const byId = new Map(
      (all.body.items as Array<{ shopId: string; todayStatus: string }>).map((item) => [
        item.shopId,
        item.todayStatus,
      ]),
    )
    expect(byId.get(shopA.shopId)).toBe('OPEN')
    expect(byId.get(shopOrgWide.shopId)).toBe('OPEN')
    expect(byId.get(shopB.shopId)).toBe('PENDING_CONFIRMATION')
  })

  it('validates the payload (400) — missing organizationId, non-boolean isOpen, oversized reason', async () => {
    const missingOrg = await request(app)
      .patch(PATH)
      .set(TOKEN_HEADER, env.inventoryInternalToken)
      .send({ isOpen: true })
    expect(missingOrg.status).toBe(400)

    const badIsOpen = await request(app)
      .patch(PATH)
      .set(TOKEN_HEADER, env.inventoryInternalToken)
      .send({ organizationId: 'org', isOpen: 'yes' })
    expect(badIsOpen.status).toBe(400)

    const longReason = await request(app)
      .patch(PATH)
      .set(TOKEN_HEADER, env.inventoryInternalToken)
      .send({ organizationId: 'org', isOpen: false, reason: 'x'.repeat(201) })
    expect(longReason.status).toBe(400)

    const missingQuery = await request(app).get(PATH).set(TOKEN_HEADER, env.inventoryInternalToken)
    expect(missingQuery.status).toBe(400)
  })
})
