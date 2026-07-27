import type { NextFunction, Request, RequestHandler, Response } from 'express'
import multer from 'multer'

import env from '../../config/env'
import { createHttpError } from '../../utils/httpError'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.imageUploadMaxBytes,
    files: 1,
  },
  fileFilter: (_request, file, callback) => {
    if (!file.mimetype.startsWith('image/')) {
      callback(createHttpError(400, 'Only image uploads are supported'))
      return
    }

    callback(null, true)
  },
})

// Wraps multer's single-file parse so its errors flow through the app's normal
// `next(error)` → error-handler path instead of multer's own throw-in-middleware shape —
// mounted ahead of `uploadShopLogoHandler` on the shop-owner logo route.
const parseShopLogoUpload: RequestHandler = (
  request: Request,
  response: Response,
  next: NextFunction,
) => {
  upload.single('file')(request, response, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        next(
          createHttpError(
            400,
            `Image must be smaller than ${Math.floor(env.imageUploadMaxBytes / (1024 * 1024))}MB`,
          ),
        )
        return
      }

      next(createHttpError(400, error.message))
      return
    }

    next(error)
  })
}

export { parseShopLogoUpload }
