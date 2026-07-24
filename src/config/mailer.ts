import nodemailer, { type Transporter } from 'nodemailer'

import env from './env'

let transporter: Transporter | null | undefined

/**
 * Lazily builds a nodemailer transporter from generic SMTP_* env vars.
 * Provider-agnostic on purpose — any SMTP-speaking service (SES, Postmark,
 * SendGrid SMTP relay, Mailtrap, a self-hosted Postfix, etc.) can be plugged
 * in purely through env vars, no vendor SDK.
 *
 * Returns `null` when SMTP_HOST is not configured so callers can fall back
 * to logging the message instead of sending it (useful for local dev/CI
 * where no real mail server is reachable).
 */
function getMailTransporter(): Transporter | null {
  if (transporter !== undefined) {
    return transporter
  }

  if (!env.smtpHost) {
    transporter = null
    return transporter
  }

  transporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure,
    auth:
      env.smtpUser && env.smtpPass
        ? { user: env.smtpUser, pass: env.smtpPass }
        : undefined,
  })

  return transporter
}

interface SendMailInput {
  to: string
  subject: string
  text: string
  html?: string
}

/**
 * Sends an email via the configured SMTP transport. When SMTP is not
 * configured (no SMTP_HOST), the message is logged to the console instead
 * of failing outright — keeps local/dev/test flows usable without a real
 * mail provider, while still exercising the rest of the OTP flow.
 */
async function sendMail(input: SendMailInput): Promise<{ delivered: boolean }> {
  const mailer = getMailTransporter()

  if (!mailer) {
    console.warn(
      `[NearKart] SMTP is not configured — logging email instead of sending.\n` +
        `  To: ${input.to}\n  Subject: ${input.subject}\n  Body: ${input.text}`,
    )
    return { delivered: false }
  }

  await mailer.sendMail({
    from: env.smtpFrom,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  })

  return { delivered: true }
}

export { getMailTransporter, sendMail }
