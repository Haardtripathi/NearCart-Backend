import env from '../config/env'

const getInventoryBridgeMeta = () => ({
  ready: Boolean(env.inventoryServiceUrl),
  strategy: 'main-backend-to-inventory-service',
  baseUrl: env.inventoryServiceUrl || null,
  lastSync: null,
})

export { getInventoryBridgeMeta }
