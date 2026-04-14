import crypto from 'crypto'

function createRefreshTokenValue(): string {
  return crypto.randomBytes(48).toString('hex')
}

function hashToken(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export { createRefreshTokenValue, hashToken }
