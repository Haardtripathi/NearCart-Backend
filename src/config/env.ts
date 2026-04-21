const parsePort = (value: string | undefined, fallback: number): number => {
  const parsedValue = Number.parseInt(value ?? '', 10)

  return Number.isNaN(parsedValue) ? fallback : parsedValue
}

const parseInteger = (value: string | undefined, fallback: number): number => {
  const parsedValue = Number.parseInt(value ?? '', 10)

  return Number.isNaN(parsedValue) ? fallback : parsedValue
}

const parseOrigins = (value: string): string[] =>
  value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

const defaultFrontendUrl = 'http://localhost:5173'
const configuredOrigins =
  process.env.CORS_ORIGIN || process.env.FRONTEND_URL || defaultFrontendUrl

const env = {
  appName: process.env.APP_NAME || 'NearKart Main App',
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parsePort(process.env.PORT, 5002),
  frontendUrl: process.env.FRONTEND_URL || defaultFrontendUrl,
  corsOrigins: parseOrigins(configuredOrigins),
  inventoryServiceUrl:
    process.env.INVENTORY_API_BASE_URL || process.env.INVENTORY_SERVICE_URL || '',
  inventoryInternalToken: process.env.INVENTORY_INTERNAL_TOKEN || '',
  inventoryRequestTimeoutMs: parseInteger(
    process.env.INVENTORY_REQUEST_TIMEOUT_MS,
    8000,
  ),
  databaseUrl: process.env.DATABASE_URL || 'file:./prisma/nearkart.db',
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || 'nearkart-dev-access-secret',
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  refreshTokenTtlDays: parseInteger(process.env.AUTH_REFRESH_TTL_DAYS, 30),
  authRefreshCookieName:
    process.env.AUTH_REFRESH_COOKIE_NAME || 'nearkart_refresh',
  adminBootstrapEmail: process.env.ADMIN_BOOTSTRAP_EMAIL || '',
  adminBootstrapPassword: process.env.ADMIN_BOOTSTRAP_PASSWORD || '',
  adminBootstrapFullName:
    process.env.ADMIN_BOOTSTRAP_FULL_NAME || 'NearKart Platform Admin',
}

export default env
