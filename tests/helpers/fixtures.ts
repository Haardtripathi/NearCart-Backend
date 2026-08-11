/**
 * Shared test fixtures: registering+logging in a customer, and registering+approving+mapping a
 * shop end to end through the real HTTP API (register -> create shop -> admin approve -> admin
 * map to a fake inventory org/branch -> shop owner confirms today-open), so tests exercise the
 * exact same gates real traffic goes through rather than seeding rows directly with Prisma.
 *
 * The one deliberate shortcut: `registerVerifiedCustomer` flips `User.isVerified` directly via
 * Prisma after registering, instead of driving a real email-OTP round trip. That gate
 * (`assertCustomerIsVerified` in orders.service.ts) exists to stop unverified accounts from
 * checking out — it has nothing to do with delivery-fee calculation, which is what this suite is
 * about, so bypassing it directly is simpler and more reliable than wiring up a test mailer.
 */
import { randomUUID } from 'node:crypto'

import request from 'supertest'

import app from '../../src/app'
import env from '../../src/config/env'
import prisma from '../../src/lib/prisma'
import { ensureBootstrapAdmin } from '../../src/services/bootstrap.service'

const TEST_PASSWORD = 'TestPassword123!'

function expectStatus(response: request.Response, expected: number, label: string): void {
  if (response.status !== expected) {
    throw new Error(
      `${label}: expected HTTP ${expected}, got ${response.status} — ${JSON.stringify(response.body)}`,
    )
  }
}

interface CustomerFixture {
  userId: string
  email: string
  accessToken: string
}

async function registerVerifiedCustomer(): Promise<CustomerFixture> {
  const email = `customer-${randomUUID()}@test.nearcart.local`

  const response = await request(app).post('/api/auth/register/customer').send({
    fullName: 'Test Customer',
    email,
    password: TEST_PASSWORD,
  })

  expectStatus(response, 201, 'registerVerifiedCustomer')

  const userId = response.body.user.id as string

  await prisma.user.update({
    where: { id: userId },
    data: { isVerified: true },
  })

  return { userId, email, accessToken: response.body.accessToken as string }
}

let cachedAdminAccessToken: Promise<string> | null = null

/**
 * Bootstraps (idempotent — `ensureBootstrapAdmin` no-ops if the account already exists) and logs
 * in the admin account defined by `ADMIN_BOOTSTRAP_EMAIL`/`ADMIN_BOOTSTRAP_PASSWORD` in
 * `.env.test`. Cached per test-file process so repeated shop fixtures in the same file don't each
 * pay a bootstrap + login round trip.
 */
async function getAdminAccessToken(): Promise<string> {
  if (!cachedAdminAccessToken) {
    cachedAdminAccessToken = (async () => {
      await ensureBootstrapAdmin()

      const response = await request(app).post('/api/auth/login').send({
        email: env.adminBootstrapEmail,
        password: env.adminBootstrapPassword,
      })

      expectStatus(response, 200, 'getAdminAccessToken (login)')

      return response.body.accessToken as string
    })()
  }

  return cachedAdminAccessToken
}

interface ShopFixtureOptions {
  /** Omit (along with `longitude`) to test the "shop has no coordinates" fallback path. */
  latitude?: number | null
  longitude?: number | null
  deliveryFeeDefault?: number
  serviceRadiusKm?: number
  deliveryEnabled?: boolean
  minimumOrderAmount?: number
}

interface ShopFixture {
  shopId: string
  shopSlug: string
  ownerAccessToken: string
  ownerUserId: string
  deliveryFeeDefault: number
  serviceRadiusKm: number
  latitude: number | null
  longitude: number | null
}

/**
 * Registers a shop owner, creates a shop, then drives it through every gate needed for it to be
 * checkout-eligible on the public storefront:
 *  - admin approval (`ShopApprovalStatus.APPROVED`)
 *  - admin storefront mapping (`inventoryOrganizationId`/`inventoryBranchId`/
 *    `publicCatalogEnabled: true` — required by `getMappedPublicShop`'s `PUBLIC_SHOP_WHERE`)
 *  - shop owner's today-open confirmation (required by `assertShopIsOpenToday`, enforced by both
 *    `POST /public/cart/validate` and `POST /orders`)
 *
 * The inventory org/branch ids are fake — fine, since `checkInventoryAvailability` is mocked at
 * the test level (see tests/helpers/inventory-mock-data.ts) rather than validated against a real
 * NearCart-Inventory instance.
 */
async function createApprovedShop(options: ShopFixtureOptions = {}): Promise<ShopFixture> {
  const email = `shopowner-${randomUUID()}@test.nearcart.local`

  const registerResponse = await request(app).post('/api/auth/register/shop-owner').send({
    fullName: 'Test Shop Owner',
    email,
    password: TEST_PASSWORD,
    businessName: `Test Business ${randomUUID()}`,
  })

  expectStatus(registerResponse, 201, 'createApprovedShop (register shop owner)')

  const ownerUserId = registerResponse.body.user.id as string
  const ownerAccessToken = registerResponse.body.accessToken as string

  const deliveryFeeDefault = options.deliveryFeeDefault ?? 35
  const serviceRadiusKm = options.serviceRadiusKm ?? 50
  const hasCoordinates = options.latitude != null && options.longitude != null

  const createShopResponse = await request(app)
    .post('/api/shop-owner/shops')
    .set('Authorization', `Bearer ${ownerAccessToken}`)
    .send({
      name: `Test Shop ${randomUUID()}`,
      category: 'Grocery',
      phone: '9999999999',
      addressLine1: '123 Test Street',
      city: 'Test City',
      pincode: '110001',
      ...(hasCoordinates
        ? { latitude: options.latitude, longitude: options.longitude }
        : {}),
      deliveryEnabled: options.deliveryEnabled ?? true,
      deliveryFeeDefault,
      serviceRadiusKm,
      minimumOrderAmount: options.minimumOrderAmount ?? 0,
    })

  expectStatus(createShopResponse, 201, 'createApprovedShop (create shop)')

  const shopId = createShopResponse.body.item.id as string
  const shopSlug = createShopResponse.body.item.slug as string

  const adminAccessToken = await getAdminAccessToken()

  const approvalResponse = await request(app)
    .patch(`/api/admin/shops/${shopId}/approval`)
    .set('Authorization', `Bearer ${adminAccessToken}`)
    .send({ approvalStatus: 'APPROVED' })

  expectStatus(approvalResponse, 200, 'createApprovedShop (admin approval)')

  const storefrontResponse = await request(app)
    .patch(`/api/admin/shops/${shopId}/storefront`)
    .set('Authorization', `Bearer ${adminAccessToken}`)
    .send({
      inventoryOrganizationId: `test-org-${randomUUID()}`,
      inventoryBranchId: `test-branch-${randomUUID()}`,
      publicCatalogEnabled: true,
    })

  expectStatus(storefrontResponse, 200, 'createApprovedShop (admin storefront mapping)')

  const todayStatusResponse = await request(app)
    .patch(`/api/shop-owner/shops/${shopId}/today-status`)
    .set('Authorization', `Bearer ${ownerAccessToken}`)
    .send({ isOpen: true })

  expectStatus(todayStatusResponse, 200, 'createApprovedShop (mark open today)')

  return {
    shopId,
    shopSlug,
    ownerAccessToken,
    ownerUserId,
    deliveryFeeDefault,
    serviceRadiusKm,
    latitude: options.latitude ?? null,
    longitude: options.longitude ?? null,
  }
}

export { createApprovedShop, getAdminAccessToken, registerVerifiedCustomer }
export type { CustomerFixture, ShopFixture }
