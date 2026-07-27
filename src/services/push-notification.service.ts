import prisma from '../lib/prisma'

const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send'
// Expo's documented max messages per request — see
// https://docs.expo.dev/push-notifications/sending-notifications/#push-tickets-request
const EXPO_PUSH_BATCH_SIZE = 100

interface SendPushInput {
  tokens: string[]
  title: string
  body: string
  data?: Record<string, string>
  // 'order_alert' is the loud/high-importance channel (see mobile app's notification-channel
  // setup) used for events the customer shouldn't miss (driver assigned, out for delivery). The
  // actual loud/distinct sound comes from that Android notification channel's own config (set
  // once at channel-creation time on the client) — Android doesn't let a push payload override a
  // channel's sound per-message, so this only affects iOS/the message-level `sound` field.
  channelId?: 'default' | 'order_alert'
}

interface ExpoPushTicket {
  status: 'ok' | 'error'
  id?: string
  message?: string
  details?: { error?: string }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

/**
 * Sends via Expo's push API (https://exp.host/--/api/v2/push/send), not Firebase Admin directly.
 *
 * Fixed 2026-07-27: this previously called `admin.messaging().sendEachForMulticast()` with the
 * tokens stored in `DeviceToken.expoPushToken` — but those are Expo push tokens
 * (`ExponentPushToken[...]`), a format only Expo's own push relay understands. Firebase Admin
 * expects raw FCM/APNs device registration tokens, which are a different value obtained via
 * `Notifications.getDevicePushTokenAsync()`, not `getExpoPushTokenAsync()`. Sending an Expo token
 * to Firebase Admin would silently fail (invalid-registration-token) for every single push. Since
 * every mobile client in this family is Expo-managed, using Expo's push API directly is simpler
 * and correct: no native FCM/APNs wiring needed client-side, no Firebase Admin credentials needed
 * for this feature at all.
 *
 * No-ops with a logged warning (not a thrown error) when there are no tokens to send to — callers
 * should not need to guard either case themselves. Network/API failures are caught here so a
 * best-effort push never turns into an unhandled rejection or a 500 for otherwise-successful
 * business logic (matches the resilience posture of the code this replaced).
 */
async function sendPushToTokens(input: SendPushInput): Promise<void> {
  if (input.tokens.length === 0) {
    return
  }

  const validTokens = input.tokens.filter((token) => token.startsWith('ExponentPushToken['))

  if (validTokens.length === 0) {
    console.warn(
      `[push-notification] No valid Expo push tokens among ${input.tokens.length} token(s) for "${input.title}" — skipping.`,
    )
    return
  }

  try {
    const staleTokens: string[] = []

    for (const batch of chunk(validTokens, EXPO_PUSH_BATCH_SIZE)) {
      const messages = batch.map((token) => ({
        to: token,
        title: input.title,
        body: input.body,
        data: input.data,
        sound: 'default',
        channelId: input.channelId ?? 'default',
        priority: 'high',
      }))

      const response = await fetch(EXPO_PUSH_API_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(10_000),
      })

      const payload = (await response.json().catch(() => null)) as { data?: ExpoPushTicket[] } | null

      if (!response.ok || !payload?.data) {
        console.warn(`[push-notification] Expo push API request failed with status ${response.status}`)
        continue
      }

      payload.data.forEach((ticket, index) => {
        const token = batch[index]
        if (token && ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          staleTokens.push(token)
        }
      })
    }

    if (staleTokens.length > 0) {
      await prisma.deviceToken.deleteMany({ where: { expoPushToken: { in: staleTokens } } })
    }
  } catch (error) {
    console.warn(
      `[push-notification] Failed to send push "${input.title}" to ${validTokens.length} token(s):`,
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

export { sendPushToCustomer, sendPushToTokens }
