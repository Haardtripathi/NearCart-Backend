import type { HttpError } from '../types/http'

function createHttpError(
  status: number,
  message: string,
  details?: unknown,
): HttpError {
  const error = new Error(message) as HttpError
  error.status = status

  if (details) {
    error.details = details
  }

  return error
}

export { createHttpError }
