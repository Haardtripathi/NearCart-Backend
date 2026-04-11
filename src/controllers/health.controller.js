const env = require('../config/env')
const { getTimestamp } = require('../utils/time')

const getHealth = (_request, response) => {
  response.status(200).json({
    status: 'ok',
    appName: env.appName,
    timestamp: getTimestamp(),
  })
}

module.exports = {
  getHealth,
}
