const env = require('../config/env')

const getInventoryBridgeMeta = () => ({
  ready: Boolean(env.inventoryServiceUrl),
  strategy: 'main-backend-to-inventory-service',
  baseUrl: env.inventoryServiceUrl || null,
  lastSync: null,
})

module.exports = {
  getInventoryBridgeMeta,
}
