import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app'
import { getMessaging } from 'firebase-admin/messaging'
import {
  activeDeviceTokensForUser, deactivateDeviceTokenValue
} from '../db.js'
import { isUserConnected } from '../realtime.js'

let firebaseApp = null

function firebaseCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n')
      }
      return cert(serviceAccount)
    } catch (error) {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON is invalid: ${error.message}`)
    }
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return applicationDefault()
  return null
}

async function firebaseTransport(message) {
  const credential = firebaseCredential()
  if (!credential) return null
  if (!firebaseApp) {
    firebaseApp = getApps()[0] || initializeApp({ credential })
  }
  return getMessaging(firebaseApp).sendEachForMulticast(message)
}

const invalidTokenCodes = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered'
])

function stringData(data) {
  return Object.fromEntries(
    Object.entries(data || {})
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  )
}

export async function sendPushToUser({ userId, title, body, data }, { transport = firebaseTransport } = {}) {
  const records = activeDeviceTokensForUser(userId)
  if (records.length === 0) return { sent: 0, skipped: 'no_active_tokens' }

  const message = {
    tokens: records.map(record => record.fcmToken),
    notification: { title, body },
    data: stringData({ ...data, rider_id: userId }),
    android: {
      priority: 'high',
      notification: { channelId: 'seatline-prompts', visibility: 'public' }
    }
  }
  const response = await transport(message)
  if (!response) return { sent: 0, skipped: 'firebase_not_configured' }

  response.responses?.forEach((item, index) => {
    if (!item.success && invalidTokenCodes.has(item.error?.code)) {
      deactivateDeviceTokenValue(message.tokens[index], item.error.code)
    }
  })
  return {
    sent: response.successCount || 0,
    failed: response.failureCount || 0
  }
}

export async function sendPushIfUserOffline(payload, options) {
  if (isUserConnected(payload.userId)) return { sent: 0, skipped: 'socket_connected' }
  try {
    return await sendPushToUser(payload, options)
  } catch (error) {
    console.error('FCM delivery failed:', error.message)
    return { sent: 0, failed: 1, error: error.message }
  }
}
