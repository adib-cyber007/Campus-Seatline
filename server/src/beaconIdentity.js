import crypto from 'node:crypto'

export const BEACON_ADVERTISING_MODE = 'legacy'
export const BEACON_ADVERTISING_INTERVAL_MS = 350

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function normalizeServiceUuid(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return UUID_PATTERN.test(normalized) ? normalized : null
}

export function serviceUuidForBusId(busId) {
  const bytes = crypto.createHash('sha256')
    .update(`campus-seatline:bus:${busId}`)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function beaconIdentityForBus(busId, current = null) {
  return {
    serviceUuid: normalizeServiceUuid(current?.serviceUuid) || serviceUuidForBusId(busId),
    advertisingMode: BEACON_ADVERTISING_MODE,
    advertisingIntervalMs: BEACON_ADVERTISING_INTERVAL_MS,
    active: current?.active !== false
  }
}
