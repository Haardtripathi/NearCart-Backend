const parsePort = (value: string | undefined, fallback: number): number => {
  const parsedValue = Number.parseInt(value ?? '', 10)

  if (Number.isNaN(parsedValue) || parsedValue <= 0 || parsedValue > 65535) {
    return fallback
  }

  return parsedValue
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

function assertProductionSecret(name: string, value: string): void {
  if (process.env.NODE_ENV !== 'production') {
    return
  }

  const weakDevelopmentValues = new Set([
    '',
    'change-me-to-a-long-random-secret',
    'nearkart-dev-access-secret',
  ])

  if (weakDevelopmentValues.has(value) || value.length < 32) {
    throw new Error(`${name} must be configured with a strong production secret`)
  }
}

function assertProductionRequired(name: string, value: string): void {
  if (process.env.NODE_ENV === 'production' && !value) {
    throw new Error(`${name} must be configured in production`)
  }
}

const defaultFrontendUrl = 'http://localhost:5173'
const defaultDatabaseUrl = 'file:./prisma/nearkart.db'
const configuredOrigins =
  process.env.CORS_ORIGIN || process.env.FRONTEND_URL || defaultFrontendUrl
const nodeEnv = process.env.NODE_ENV || 'development'
const databaseUrl = process.env.DATABASE_URL || defaultDatabaseUrl
const jwtAccessSecret =
  process.env.JWT_ACCESS_SECRET || 'nearkart-dev-access-secret'

assertProductionRequired('DATABASE_URL', process.env.DATABASE_URL || '')
assertProductionSecret('JWT_ACCESS_SECRET', jwtAccessSecret)

const env = {
  appName: process.env.APP_NAME || 'NearKart Main App',
  nodeEnv,
  port: parsePort(process.env.PORT, 5002),
  frontendUrl: process.env.FRONTEND_URL || defaultFrontendUrl,
  corsOrigins: parseOrigins(configuredOrigins),
  requestBodyLimit: process.env.REQUEST_BODY_LIMIT || '1mb',
  inventoryServiceUrl:
    process.env.INVENTORY_API_BASE_URL || process.env.INVENTORY_SERVICE_URL || '',
  inventoryInternalToken: process.env.INVENTORY_INTERNAL_TOKEN || '',
  inventoryRequestTimeoutMs: parseInteger(
    process.env.INVENTORY_REQUEST_TIMEOUT_MS,
    8000,
  ),
  databaseUrl,
  jwtAccessSecret,
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  refreshTokenTtlDays: parseInteger(process.env.AUTH_REFRESH_TTL_DAYS, 30),
  authRefreshCookieName:
    process.env.AUTH_REFRESH_COOKIE_NAME || 'nearkart_refresh',
  adminBootstrapEmail: process.env.ADMIN_BOOTSTRAP_EMAIL || '',
  adminBootstrapPassword: process.env.ADMIN_BOOTSTRAP_PASSWORD || '',
  adminBootstrapFullName:
    process.env.ADMIN_BOOTSTRAP_FULL_NAME || 'NearKart Platform Admin',
  otpProvider: process.env.OTP_PROVIDER || '',
  otpSenderId: process.env.OTP_SENDER_ID || '',
  otpApiKey: process.env.OTP_API_KEY || '',
  otpTtlSeconds: parseInteger(process.env.OTP_TTL_SECONDS, 600),
  otpResendCooldownSeconds: parseInteger(
    process.env.OTP_RESEND_COOLDOWN_SECONDS,
    60,
  ),
  otpMaxVerifyAttempts: parseInteger(process.env.OTP_MAX_VERIFY_ATTEMPTS, 5),
  redisUrl: process.env.REDIS_URL || '',
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parsePort(process.env.SMTP_PORT, 587),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpFrom: process.env.SMTP_FROM || 'NearKart <no-reply@nearkart.local>',
  smtpSecure: process.env.SMTP_SECURE === 'true',
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  defaultServiceRadiusKm:
    Number.parseFloat(process.env.DEFAULT_SERVICE_RADIUS_KM || '') || 10,
  // Number of reverse-proxy hops Express should trust when deriving the
  // client IP from X-Forwarded-For (e.g. 1 behind a single nginx/Render/
  // Railway/Heroku-style proxy). Defaults to 1 in production — nearly every
  // real deployment sits behind at least one proxy/load balancer — and 0
  // (no proxy trusted) in development, where requests normally arrive
  // directly. This MUST be set correctly for express-rate-limit: without
  // it, any request carrying an X-Forwarded-For header (which any proxy
  // adds) makes express-rate-limit throw ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
  // on every rate-limited route (register/login/orders/otp/public/location),
  // and even if that didn't throw, req.ip would resolve to the proxy's IP
  // for every request, collapsing per-IP rate limiting into one shared
  // bucket for all users.
  trustProxyHops: parseInteger(
    process.env.TRUST_PROXY_HOPS,
    nodeEnv === 'production' ? 1 : 0,
  ),
}

export default env
