import nodemailer, { type Transporter } from 'nodemailer'

import env from './env'
import { createHttpError } from '../utils/httpError'

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
    // Bug found 2026-08-01: with no explicit timeout, nodemailer's default connectionTimeout is
    // 2 minutes — confirmed live in prod (a hung SMTP connection to smtp.gmail.com:587, almost
    // certainly blocked by the hosting provider's egress rules, took exactly ~2 minutes to fail).
    // Failing fast doesn't fix SMTP being blocked, but stops a single bad send from hanging this
    // long. See sendMail() below — Resend is now preferred when configured, which sidesteps this
    // entirely.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  })

  return transporter
}

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email'

/**
 * Parses "Display Name <email@domain>" into separate fields — Brevo's HTTP API wants them
 * split, unlike nodemailer/Resend which accept the combined string directly.
 */
function parseFromAddress(raw: string): { name?: string; email: string } {
  const match = raw.match(/^(.*)<(.+)>$/)

  if (!match) {
    return { email: raw.trim() }
  }

  const name = match[1]!.trim()
  const email = match[2]!.trim()
  return name ? { name, email } : { email }
}

/**
 * Sends via Brevo's HTTP API rather than its own SMTP relay — see BREVO_API_KEY's doc comment in
 * config/env.ts. Confirmed live 2026-08-01: Brevo's SMTP relay (smtp-relay.brevo.com:587) itself
 * gets ETIMEDOUT from this exact Render service despite identical credentials working fine on
 * NearCart-Inventory's service — a real per-service network egress restriction, not a config
 * issue. A normal HTTPS POST isn't subject to that at all.
 */
async function sendMailViaBrevo(input: SendMailInput): Promise<{ delivered: boolean }> {
  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': env.brevoApiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: parseFromAddress(env.brevoFrom),
      to: [{ email: input.to }],
      subject: input.subject,
      htmlContent: input.html,
      textContent: input.text,
    }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    console.error(`[NearKart] Brevo API request failed with status ${response.status}: ${body}`)
    throw createHttpError(502, 'Failed to send email. Please try again shortly.')
  }

  return { delivered: true }
}

const RESEND_API_URL = 'https://api.resend.com/emails'

async function sendMailViaResend(input: SendMailInput): Promise<{ delivered: boolean }> {
  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.resendFrom,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    console.error(`[NearKart] Resend API request failed with status ${response.status}: ${body}`)
    throw createHttpError(502, 'Failed to send email. Please try again shortly.')
  }

  return { delivered: true }
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
  if (env.brevoApiKey) {
    return sendMailViaBrevo(input)
  }

  const mailer = getMailTransporter()

  if (!mailer) {
    if (env.resendApiKey) {
      return sendMailViaResend(input)
    }

    console.warn(
      `[NearKart] No email provider configured (BREVO_API_KEY / SMTP / RESEND_API_KEY all unset) — logging email instead of sending.\n` +
        `  To: ${input.to}\n  Subject: ${input.subject}\n  Body: ${input.text}`,
    )
    return { delivered: false }
  }

  try {
    await mailer.sendMail({
      from: env.smtpFrom,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    })
  } catch (error) {
    // nodemailer/SMTP errors can include transport details (host, auth
    // failure reasons) that must not be forwarded to the client verbatim —
    // log server-side and surface a clean, generic error instead.
    console.error('[NearKart] Failed to send email via SMTP:', error)
    throw createHttpError(502, 'Failed to send email. Please try again shortly.')
  }

  return { delivered: true }
}

export { getMailTransporter, sendMail }
