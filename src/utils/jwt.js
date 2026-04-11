const jwt = require('jsonwebtoken')

const env = require('../config/env')

function signAccessToken(user) {
  return jwt.sign(
    {
      role: user.role,
      email: user.email,
    },
    env.jwtAccessSecret,
    {
      expiresIn: env.jwtAccessExpiresIn,
      subject: user.id,
    },
  )
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtAccessSecret)
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
}
