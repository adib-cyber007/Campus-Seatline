import { Capacitor, registerPlugin } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'
import { api, getApiOrigin, getToken } from './api'

const TOKEN_KEY = 'seatline_fcm_token'
let activeUserId = null
let listenerHandles = []
const NativeNotificationActions = registerPlugin('SeatlineNotificationActions')

function isAndroidNative() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

async function clearListeners() {
  const handles = listenerHandles
  listenerHandles = []
  await Promise.all(handles.map(handle => handle.remove().catch(() => {})))
}

export async function startRiderPush({ userId, onStatus, onResponse }) {
  if (!isAndroidNative()) return { supported: false }
  if (activeUserId === userId) return { supported: true, alreadyStarted: true }

  activeUserId = userId
  await clearListeners()
  const apiOrigin = getApiOrigin()
  const authToken = getToken()
  if (!apiOrigin || !authToken) {
    activeUserId = null
    throw new Error('Connect to the Campus Seatline server and sign in before enabling notifications')
  }
  try {
    await NativeNotificationActions.configure({ apiOrigin, authToken, userId })
  } catch (error) {
    activeUserId = null
    throw error
  }


  listenerHandles = await Promise.all([
    PushNotifications.addListener('registration', async token => {
      try {
        const previousToken = localStorage.getItem(TOKEN_KEY)
        await api('/rider/device-tokens', {
          method: 'POST',
          body: {
            fcmToken: token.value,
            previousToken: previousToken && previousToken !== token.value ? previousToken : undefined,
            platform: 'android'
          }
        })
        localStorage.setItem(TOKEN_KEY, token.value)
        onStatus?.('Push notifications are ready', 'feedback')
      } catch (error) {
        onStatus?.(`Push registration failed: ${error.message}`, 'error')
      }
    }),
    PushNotifications.addListener('registrationError', error => {
      onStatus?.(`Push registration failed: ${error.error}`, 'error')
    }),
    PushNotifications.addListener('pushNotificationReceived', () => {
      onResponse?.()
    }),
    PushNotifications.addListener('pushNotificationActionPerformed', async action => {
      const payload = action.notification?.data || {}
      const answer = String(action.actionId || '').toLowerCase()
      if (payload.event_type !== 'ble_confirmation_prompt' || !payload.event_id || !['yes', 'no'].includes(answer)) {
        onResponse?.()
        return
      }
      try {
        await api(`/rider/prompts/${payload.event_id}/respond`, {
          method: 'POST', body: { response: answer }
        })
        onStatus?.(`Boarding response recorded: ${answer === 'yes' ? 'Yes' : 'No'}`, 'feedback')
        onResponse?.()
      } catch (error) {
        onStatus?.(error.message, 'error')
      }
    })
  ])

  await PushNotifications.createChannel({
    id: 'seatline-prompts',
    name: 'Boarding prompts',
    description: 'Time-sensitive bus boarding and arrival updates',
    importance: 4,
    visibility: 1,
    vibration: true
  })

  let permissions = await PushNotifications.checkPermissions()
  if (permissions.receive === 'prompt' || permissions.receive === 'prompt-with-rationale') {
    permissions = await PushNotifications.requestPermissions()
  }
  if (permissions.receive !== 'granted') {
    onStatus?.('Notifications are off. You can enable them later in Android settings.', 'info')
    return { supported: true, granted: false }
  }

  await PushNotifications.register()
  return { supported: true, granted: true }
}

export async function unregisterRiderPush() {
  if (!isAndroidNative()) return
  const fcmToken = localStorage.getItem(TOKEN_KEY)
  let serverError = null
  if (fcmToken) {
    try {
      await api('/rider/device-tokens', { method: 'DELETE', body: { fcmToken } })
    } catch (error) {
      serverError = error
    } finally {
      localStorage.removeItem(TOKEN_KEY)
    }
  }
  await PushNotifications.unregister().catch(() => {})
  await clearListeners()
  await NativeNotificationActions.clear().catch(() => {})
  activeUserId = null
  if (serverError) throw serverError
}
