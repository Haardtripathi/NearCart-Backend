import { v2 as cloudinary } from 'cloudinary'

import env from './env'
import { createHttpError } from '../utils/httpError'

// Lazy-init, same pattern as NearCart-Inventory/backend's
// `modules/uploads/uploads.service.ts` (`ensureCloudinaryConfigured`): the rest of the app must
// keep running before real Cloudinary credentials exist, so this throws a clear 503 at call time
// rather than crashing the process at boot when env vars are unset.
let configured = false

function ensureCloudinaryConfigured(): typeof cloudinary {
  if (!env.cloudinaryCloudName || !env.cloudinaryApiKey || !env.cloudinaryApiSecret) {
    throw createHttpError(503, 'Image upload is not configured on the server')
  }

  if (!configured) {
    cloudinary.config({
      cloud_name: env.cloudinaryCloudName,
      api_key: env.cloudinaryApiKey,
      api_secret: env.cloudinaryApiSecret,
      secure: true,
    })
    configured = true
  }

  return cloudinary
}

export { ensureCloudinaryConfigured }
