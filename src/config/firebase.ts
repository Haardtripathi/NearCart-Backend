import { type App, cert, initializeApp } from 'firebase-admin/app'

import env from './env'

let initialized = false
let app: App | null = null

function isFirebaseConfigured(): boolean {
  return Boolean(env.firebaseProjectId && env.firebaseClientEmail && env.firebasePrivateKey)
}

/**
 * Lazy, idempotent init — mirrors NearCart-Inventory's ensureCloudinaryConfigured pattern.
 * Returns null (not a thrown error) when unconfigured so callers can no-op with a logged
 * warning instead of crashing the whole request/process before real Firebase credentials exist.
 *
 * Uses firebase-admin's modular API (`firebase-admin/app`) rather than the `admin.*` namespace
 * object — v14 no longer ships the namespace-style API surface that pattern was written against.
 */
function getFirebaseApp(): App | null {
  if (!isFirebaseConfigured()) {
    return null
  }

  if (!initialized) {
    app = initializeApp({
      credential: cert({
        projectId: env.firebaseProjectId,
        clientEmail: env.firebaseClientEmail,
        privateKey: env.firebasePrivateKey,
      }),
    })
    initialized = true
  }

  return app
}

export { getFirebaseApp, isFirebaseConfigured }
