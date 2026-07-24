import type { NextFunction, Request, Response } from 'express'

import {
  requestEmailVerificationOtp,
  verifyEmailVerificationOtp,
} from '../services/otp.service'
import { buildMeta } from '../utils/response'
import { verifyOtpSchema } from '../validation/otp.validation'

async function sendOtpHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = request.auth!.user
    const result = await requestEmailVerificationOtp({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      isVerified: user.isVerified,
    })

    response.status(200).json({
      success: true,
      message: result.delivered
        ? 'Verification code sent to your email.'
        : 'Verification code generated (email delivery not configured — check server logs in dev).',
      cooldownSeconds: result.cooldownSeconds,
      meta: buildMeta(),
    })
  } catch (error) {
    next(error)
  }
}

async function verifyOtpHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = verifyOtpSchema.parse(request.body)

    await verifyEmailVerificationOtp(request.auth!.userId, payload.code)

    response.status(200).json({
      success: true,
      message: 'Email verified successfully.',
      meta: buildMeta(),
    })
  } catch (error) {
    next(error)
  }
}

export { sendOtpHandler, verifyOtpHandler }
