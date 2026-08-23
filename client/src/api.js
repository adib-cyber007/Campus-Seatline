const TOKEN_KEY = 'bus_token'
const API_ORIGIN_KEY = 'seatline_api_origin'

function normalizeApiOrigin(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''

  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('Enter a complete server URL, for example https://seatline.example.edu')
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('The server URL must start with http:// or https://')
  }
  if (parsed.search || parsed.hash) {
    throw new Error('The server URL cannot include a query or fragment')
  }

  return trimmed.replace(/\/api$/i, '')
}

export function getApiOrigin() {
  const stored = localStorage.getItem(API_ORIGIN_KEY)
  return normalizeApiOrigin(stored || import.meta.env.VITE_API_URL || '')
}

export function setApiOrigin(value) {
  const origin = normalizeApiOrigin(value)
  if (origin) localStorage.setItem(API_ORIGIN_KEY, origin)
  else localStorage.removeItem(API_ORIGIN_KEY)
  return origin
}

export function isNativeApp() {
  return Boolean(window.Capacitor?.isNativePlatform?.())
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${getApiOrigin()}/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed')
  return data
}
