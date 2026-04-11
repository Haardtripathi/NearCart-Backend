const crypto = require('crypto')

function createRefreshTokenValue() {
  return crypto.randomBytes(48).toString('hex')
}

function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

module.exports = {
  createRefreshTokenValue,
  hashToken,
}
