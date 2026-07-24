import crypto from 'crypto'

import { sendMail } from '../config/mailer'
import env from '../config/env'
import prisma from '../lib/prisma'
import { kvDel, kvGet, kvIncr, kvSet, kvTtlRemaining } from '../lib/kvStore'
import { createHttpError } from '../utils/httpError'

const OTP_PURPOSE = 'email-verification'

function otpKey(kind: 'code' | 'cooldown' | 'attempts', userId: string): string {
  return `otp:${OTP_PURPOSE}:${kind}:${userId}`
}

function generateOtpCode(): string {
  // 6-digit numeric code, zero-padded (e.g. "004821")
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
}

function hashOtpCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex')
}

/**
 * Generates a fresh 6-digit OTP, stores its hash in Redis (or the in-memory
 * fallback) with a ~10min TTL, and emails it to the user. Enforces a resend
 * cooldown so the endpoint can't be hammered to re-trigger email sends.
 */
async function requestEmailVerificationOtp(user: {
  id: string
  email: string
  fullName: string
  isVerified: boolean
}): Promise<{ cooldownSeconds: number; delivered: boolean }> {
  if (user.isVerified) {
    throw createHttpError(400, 'This account is already verified')
  }

  const cooldownRemaining = await kvTtlRemaining(otpKey('cooldown', user.id))

  if (cooldownRemaining > 0) {
    throw createHttpError(
      429,
      `Please wait ${cooldownRemaining}s before requesting another code`,
      { retryAfterSeconds: cooldownRemaining },
    )
  }

  const code = generateOtpCode()

  await kvSet(otpKey('code', user.id), hashOtpCode(code), env.otpTtlSeconds)
  await kvDel(otpKey('attempts', user.id))
  await kvSet(otpKey('cooldown', user.id), '1', env.otpResendCooldownSeconds)

  const ttlMinutes = Math.round(env.otpTtlSeconds / 60)
  const { delivered } = await sendMail({
    to: user.email,
    subject: `${env.appName} verification code`,
    text: `Hi ${user.fullName},\n\nYour ${env.appName} verification code is ${code}. It expires in ${ttlMinutes} minutes.\n\nIf you didn't request this, you can ignore this email.`,
    html: `<p>Hi ${user.fullName},</p><p>Your ${env.appName} verification code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px;">${code}</p><p>It expires in ${ttlMinutes} minutes. If you didn't request this, you can ignore this email.</p>`,
  })

  return { cooldownSeconds: env.otpResendCooldownSeconds, delivered }
}

/**
 * Verifies a submitted OTP against the stored hash and, on success, sets
 * `User.isVerified = true`. Tracks failed attempts (capped by
 * OTP_MAX_VERIFY_ATTEMPTS) to slow down brute-force guessing of the 6-digit
 * code within its TTL window.
 */
async function verifyEmailVerificationOtp(
  userId: string,
  submittedCode: string,
): Promise<void> {
  const storedHash = await kvGet(otpKey('code', userId))

  if (!storedHash) {
    throw createHttpError(
      400,
      'No active verification code found. Please request a new one.',
    )
  }

  const attempts = await kvIncr(otpKey('attempts', userId), env.otpTtlSeconds)

  if (attempts > env.otpMaxVerifyAttempts) {
    await kvDel(otpKey('code', userId))
    throw createHttpError(
      429,
      'Too many incorrect attempts. Please request a new code.',
    )
  }

  if (hashOtpCode(submittedCode) !== storedHash) {
    throw createHttpError(400, 'Invalid or expired verification code')
  }

  await kvDel(otpKey('code', userId))
  await kvDel(otpKey('attempts', userId))

  await prisma.user.update({
    where: { id: userId },
    data: { isVerified: true },
  })
}

export { requestEmailVerificationOtp, verifyEmailVerificationOtp }
