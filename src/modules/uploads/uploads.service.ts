import { ensureCloudinaryConfigured } from '../../config/cloudinary'
import env from '../../config/env'
import { createHttpError } from '../../utils/httpError'

interface UploadShopLogoOptions {
  fileBuffer: Buffer
  shopId: string
}

interface CloudinaryUploadResult {
  url: string
  publicId: string
  width?: number
  height?: number
  format?: string
  bytes?: number
}

function sanitizePathSegment(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'general'
  )
}

// Same `upload_stream` pattern as NearCart-Inventory/backend's
// `modules/uploads/uploads.service.ts` — a multer memory buffer piped straight to Cloudinary,
// no temp file on disk.
async function uploadShopLogo({
  fileBuffer,
  shopId,
}: UploadShopLogoOptions): Promise<CloudinaryUploadResult> {
  const cloudinary = ensureCloudinaryConfigured()

  const folder = [env.cloudinaryUploadFolder, 'shops', sanitizePathSegment(shopId)].join('/')

  return new Promise<CloudinaryUploadResult>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
        unique_filename: true,
        use_filename: true,
        overwrite: false,
      },
      (error, result) => {
        if (error || !result?.secure_url || !result.public_id) {
          reject(createHttpError(400, 'Image upload failed', error))
          return
        }

        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          width: result.width,
          height: result.height,
          format: result.format,
          bytes: result.bytes,
        })
      },
    )

    stream.on('error', (error) => reject(createHttpError(400, 'Image upload failed', error)))
    stream.end(fileBuffer)
  })
}

export { uploadShopLogo }
