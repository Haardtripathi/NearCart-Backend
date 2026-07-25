import crypto from 'crypto'

import { sendMail } from '../config/mailer'
import env from '../config/env'
import prisma from '../lib/prisma'
import { kvDel, kvGet, kvIncr, kvSet, kvTtlRemaining } from '../lib/kvStore'
import { createHttpError } from '../utils/httpError'
import type { HttpError } from '../types/http'

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
 * Constant-time comparison of two equal-length hex hashes. Plain `!==`
 * would short-circuit on the first differing byte, which is a (largely
 * theoretical, given SHA-256's avalanche effect) timing side-channel;
 * `crypto.timingSafeEqual` closes it cheaply. Falls back to `false` on any
 * length mismatch rather than throwing (timingSafeEqual requires equal
 * length buffers).
 */
function safeCompareHashes(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'hex')
  const bufferB = Buffer.from(b, 'hex')

  if (bufferA.length !== bufferB.length) {
    return false
  }

  return crypto.timingSafeEqual(bufferA, bufferB)
}

/**
 * The OTP store (Redis, when configured) and the SMTP transport are both
 * external dependencies that can fail mid-flow — e.g. Redis unreachable, or
 * an SMTP auth/connection error from nodemailer. Those raw errors carry
 * infrastructure details (hostnames, ports, connection failure reasons)
 * that must never reach the client: the generic error handler forwards
 * `Error#message` verbatim for anything that isn't one of our own
 * `HttpError`s. This fails closed (never silently treats the failure as
 * "verified"/"sent") while keeping the client-facing message generic; the
 * real error is still logged server-side for debugging.
 */
async function withCleanErrors<T>(
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if ((error as HttpError | undefined)?.status) {
      throw error
    }

    console.error(`[NearKart] OTP ${operation} failed unexpectedly:`, error)

    throw createHttpError(
      503,
      'Verification service is temporarily unavailable. Please try again in a moment.',
    )
  }
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

  return withCleanErrors('send', async () => {
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
  })
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
  return withCleanErrors('verify', async () => {
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

    if (!safeCompareHashes(hashOtpCode(submittedCode), storedHash)) {
      throw createHttpError(400, 'Invalid or expired verification code')
    }

    await kvDel(otpKey('code', userId))
    await kvDel(otpKey('attempts', userId))

    await prisma.user.update({
      where: { id: userId },
      data: { isVerified: true },
    })
  })
}

export { requestEmailVerificationOtp, verifyEmailVerificationOtp }
