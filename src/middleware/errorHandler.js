function errorHandler(error, _request, response, _next) {
  if (process.env.NODE_ENV !== 'production') {
    console.error(error)
  }

  if (error.name === 'ZodError') {
    response.status(400).json({
      message: 'Invalid request payload',
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
    return
  }

  const statusCode =
    error.status || (response.statusCode >= 400 ? response.statusCode : 500)

  response.status(statusCode).json({
    message: error.message || 'Internal Server Error',
    ...(error.details ? { details: error.details } : {}),
  })
}

module.exports = errorHandler
