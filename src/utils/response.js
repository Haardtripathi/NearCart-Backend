const { getTimestamp } = require('./time')

function buildMeta(extra = {}) {
  return {
    timestamp: getTimestamp(),
    ...extra,
  }
}

module.exports = {
  buildMeta,
}
