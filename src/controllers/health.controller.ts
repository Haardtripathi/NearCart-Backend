import type { Request, Response } from 'express'

import env from '../config/env'
import { getTimestamp } from '../utils/time'

const getHealth = (_request: Request, response: Response): void => {
  response.status(200).json({
    status: 'ok',
    appName: env.appName,
    timestamp: getTimestamp(),
  })
}

export { getHealth }
