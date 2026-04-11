const bcrypt = require('bcrypt')

async function hashPassword(password) {
  return bcrypt.hash(password, 12)
}

async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash)
}

module.exports = {
  hashPassword,
  verifyPassword,
}
