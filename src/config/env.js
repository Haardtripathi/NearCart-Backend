const parsePort = (value, fallback) => {
  const parsedValue = Number.parseInt(value ?? '', 10)

  return Number.isNaN(parsedValue) ? fallback : parsedValue
}

const parseOrigins = (value) =>
  value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

const defaultFrontendUrl = 'http://localhost:5173'
const configuredOrigins =
  process.env.CORS_ORIGIN || process.env.FRONTEND_URL || defaultFrontendUrl

module.exports = {
  appName: process.env.APP_NAME || 'NearCart Main App',
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parsePort(process.env.PORT, 5002),
  frontendUrl: process.env.FRONTEND_URL || defaultFrontendUrl,
  corsOrigins: parseOrigins(configuredOrigins),
  inventoryServiceUrl: process.env.INVENTORY_SERVICE_URL || '',
  databaseUrl: process.env.DATABASE_URL || 'file:./prisma/nearcart.db',
}
