import type { RequestHandler } from 'express'

const notFoundHandler: RequestHandler = (request, response, _next) => {
  response.status(404).json({
    message: `Route ${request.originalUrl} not found`,
  })
}

export default notFoundHandler
