import type { RequestHandler } from 'express'

import { buildMeta } from '../utils/response'

const notFoundHandler: RequestHandler = (request, response, _next) => {
  response.status(404).json({
    success: false,
    message: `Route ${request.originalUrl} not found`,
    meta: buildMeta(),
  })
}

export default notFoundHandler
