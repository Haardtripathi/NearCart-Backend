// Self-import dotenv here, not just in `server.ts` — any ad-hoc script that imports this
// config module directly (e.g. a one-off Prisma script, not a full `server.ts` boot) must
// still get `.env` loaded, otherwise it silently falls back to this file's hardcoded defaults
// (e.g. `file:./prisma/nearkart.db`) instead of the real configured DB. Idempotent/safe to
// import twice — `dotenv/config` no-ops if env vars are already set (e.g. by `server.ts`
// importing this module after already importing `dotenv/config` itself).
import 'dotenv/config'

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

const isRemoteDatabase = databaseUrl.toLowerCase().startsWith('libsql://') || databaseUrl.toLowerCase().startsWith('https://')
if (isRemoteDatabase) {
  assertProductionRequired('DATABASE_AUTH_TOKEN', process.env.DATABASE_AUTH_TOKEN || '')
}

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
  // Only needed for a remote libSQL/Turso database (empty/undefined for a local `file:` URL,
  // which needs no auth) — passed separately from the URL to PrismaLibSql's Config object.
  databaseAuthToken: process.env.DATABASE_AUTH_TOKEN || '',
  jwtAccessSecret,
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  // Bumped from 30 to 90 (a "few months" tenor) — see auth.service.ts's native-client refresh
  // path, which is what actually makes a long-lived session usable on mobile (web already had a
  // working rotating-refresh-cookie flow at 30 days; the low number was never the constraint).
  refreshTokenTtlDays: parseInteger(process.env.AUTH_REFRESH_TTL_DAYS, 90),
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
  // Highest priority when set — see config/mailer.ts. Added 2026-08-01 after confirming that even
  // Brevo's own SMTP relay (smtp-relay.brevo.com:587) gets ETIMEDOUT from this exact Render
  // service despite identical credentials working fine on NearCart-Inventory's service — a real
  // per-service network egress restriction. Brevo's HTTP API isn't affected since it's a normal
  // HTTPS call, same reasoning as resendApiKey below but with Brevo's un-restricted-recipient
  // free tier instead of Resend's own-email-only sandbox.
  brevoApiKey: process.env.BREVO_API_KEY || '',
  brevoFrom: process.env.BREVO_FROM || 'NearKart <no-reply@nearkart.local>',
  // Preferred over raw SMTP below when BREVO_API_KEY is unset — see config/mailer.ts. Resend's
  // HTTP API isn't affected by SMTP-port blocking either, but its free tier restricts sending to
  // the account's own email until a domain is verified there.
  resendApiKey: process.env.RESEND_API_KEY || '',
  resendFrom: process.env.RESEND_FROM || 'NearKart <onboarding@resend.dev>',
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parsePort(process.env.SMTP_PORT, 587),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpFrom: process.env.SMTP_FROM || 'NearKart <no-reply@nearkart.local>',
  smtpSecure: process.env.SMTP_SECURE === 'true',
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  weatherApiKey: process.env.WEATHER_API_KEY || '',
  defaultServiceRadiusKm:
    Number.parseFloat(process.env.DEFAULT_SERVICE_RADIUS_KM || '') || 10,
  // Distance-based delivery fee formula (see `utils/geo.ts`'s `computeDeliveryFee`):
  // fee = clamp(deliveryFeeBase + deliveryFeePerKm * distanceKm, deliveryFeeMin, deliveryFeeMax).
  // These are placeholder business figures, not a tuned pricing model — override via env once
  // real cost data exists.
  deliveryFeeBase: parseInteger(process.env.DELIVERY_FEE_BASE, 20),
  deliveryFeePerKm: parseInteger(process.env.DELIVERY_FEE_PER_KM, 8),
  deliveryFeeMin: parseInteger(process.env.DELIVERY_FEE_MIN, 20),
  deliveryFeeMax: parseInteger(process.env.DELIVERY_FEE_MAX, 150),
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
  // Firebase Admin SDK (push notifications) — all optional; push-notification.service.ts no-ops
  // with a logged warning until these are set, rather than crashing at boot. Populate once a
  // Firebase project + service account exist.
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || '',
  firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
  // Service-account private keys are typically stored with literal "\n" sequences in .env files;
  // real newlines are restored here so admin.credential.cert() gets a valid PEM.
  firebasePrivateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  // Cloudinary (real shop-photo upload) — `cloudinary`/`multer` were already dependencies before
  // this was wired up. All optional; uploads.service.ts throws a clear 503 until these are set,
  // rather than crashing at boot, matching the existing lazy-config pattern used for Firebase.
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY || '',
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET || '',
  cloudinaryUploadFolder: process.env.CLOUDINARY_UPLOAD_FOLDER || 'nearkart',
  imageUploadMaxBytes: parseInteger(process.env.IMAGE_UPLOAD_MAX_BYTES, 5 * 1024 * 1024),
}

export default env
