function getDashboardPathForRole(role) {
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

function normalizeEmail(email) {
  return email.trim().toLowerCase()
}

function normalizeOptionalString(value) {
  const normalizedValue = value?.trim()

  return normalizedValue ? normalizedValue : null
}

module.exports = {
  getDashboardPathForRole,
  normalizeEmail,
  normalizeOptionalString,
}
