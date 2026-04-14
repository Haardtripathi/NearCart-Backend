export interface HttpError extends Error {
  status?: number
  details?: unknown
}
