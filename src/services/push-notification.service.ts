import { getMessaging } from 'firebase-admin/messaging'

import prisma from '../lib/prisma'
import { getFirebaseApp, isFirebaseConfigured } from '../config/firebase'

interface SendPushInput {
  tokens: string[]
  title: string
  body: string
  data?: Record<string, string>
  // 'order_alert' is the loud/high-importance channel (see mobile app's notification-channel
  // setup) used for events the customer shouldn't miss (driver assigned, out for delivery).
  channelId?: 'default' | 'order_alert'
}

/**
 * Thin wrapper over admin.messaging().sendEachForMulticast(). No-ops with a logged warning
 * (not a thrown error) when Firebase isn't configured yet, or when there are no tokens to send
 * to — callers should not need to guard either case themselves.
 */
async function sendPushToTokens(input: SendPushInput): Promise<void> {
  if (input.tokens.length === 0) {
    return
  }

  const app = getFirebaseApp()

  if (!app) {
    console.warn(
      `[push-notification] Firebase not configured — skipping push "${input.title}" to ${input.tokens.length} token(s).`,
    )
    return
  }

  // The FCM call (and the stale-token cleanup after it) is wrapped so a transient
  // network/credentials/quota failure degrades to a logged warning instead of an unhandled
  // rejection — this function's doc comment already promises callers don't need to guard
  // themselves, but nothing previously enforced that: a send failure here used to propagate
  // straight up into business logic like the inventory webhook handler, turning a
  // best-effort notification into a 500 for an otherwise-successful order-status update.
  try {
    const response = await getMessaging(app).sendEachForMulticast({
      tokens: input.tokens,
      notification: { title: input.title, body: input.body },
      data: input.data,
      android: {
        notification: {
          channelId: input.channelId ?? 'default',
          sound: input.channelId === 'order_alert' ? 'order_alert' : 'default',
        },
      },
    })

    const staleTokens = response.responses
      .map((result: (typeof response.responses)[number], index: number) =>
        !result.success && result.error?.code === 'messaging/registration-token-not-registered'
          ? input.tokens[index]
          : null,
      )
      .filter((token): token is string => token !== null)

    if (staleTokens.length > 0) {
      await prisma.deviceToken.deleteMany({ where: { expoPushToken: { in: staleTokens } } })
    }
  } catch (error) {
    console.warn(
      `[push-notification] Failed to send push "${input.title}" to ${input.tokens.length} token(s):`,
      error instanceof Error ? error.message : error,
    )
  }
}

/** Sends to every device token registered for the given customer User id. */
async function sendPushToCustomer(
  userId: string,
  payload: Omit<SendPushInput, 'tokens'>,
): Promise<void> {
  const deviceTokens = await prisma.deviceToken.findMany({
    where: { ownerId: userId },
    select: { expoPushToken: true },
  })

  await sendPushToTokens({ ...payload, tokens: deviceTokens.map((row) => row.expoPushToken) })
}

export { isFirebaseConfigured, sendPushToCustomer, sendPushToTokens }
