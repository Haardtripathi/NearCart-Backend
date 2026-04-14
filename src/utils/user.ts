import type { UserRole } from '@prisma/client'

function getDashboardPathForRole(role: UserRole): string {
  switch (role) {
    case 'CUSTOMER':
      return '/dashboard/customer'
    case 'SHOP_OWNER':
      return '/dashboard/shop-owner'
    case 'ADMIN':
      return '/dashboard/admin'
    case 'RIDER':
      return '/dashboard'
    default:
      return '/dashboard'
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function normalizeOptionalString(value?: string | null): string | null {
  const normalizedValue = value?.trim()

  return normalizedValue ? normalizedValue : null
}

export { getDashboardPathForRole, normalizeEmail, normalizeOptionalString }
