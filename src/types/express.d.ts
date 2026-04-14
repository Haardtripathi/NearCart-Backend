import type { RequestAuth } from './auth'

declare global {
  namespace Express {
    interface Request {
      auth?: RequestAuth | null
    }
  }
}

export {}
