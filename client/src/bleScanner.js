import { Capacitor, registerPlugin } from '@capacitor/core'

const NativeBleScanner = registerPlugin('SeatlineBleScanner')

export const DEFAULT_BEACON_MIN_RSSI = -75

export function supportsNativeBeaconScan() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

function nativeBeaconTargets(beacons = []) {
  return beacons
    .map(beacon => ({
      busId: String(beacon?.busId || '').trim(),
      uuid: String(beacon?.uuid || '').trim()
    }))
    .filter(beacon => beacon.busId && beacon.uuid)
}

export async function startServiceUuidScan({ beacons, minRssi = DEFAULT_BEACON_MIN_RSSI, timeoutMs = 30000, onDetected, onState }) {
  if (!supportsNativeBeaconScan()) {
    throw new Error('Real beacon scanning is available only in the Android app')
  }

  let disposed = false
  const handles = await Promise.all([
    NativeBleScanner.addListener('beaconDetected', event => {
      if (!disposed) onDetected?.(event)
    }),
    NativeBleScanner.addListener('scanStateChanged', event => {
      if (!disposed) onState?.(event)
    })
  ])

  const dispose = async () => {
    if (disposed) return
    disposed = true
    await Promise.all(handles.map(handle => handle.remove().catch(() => {})))
  }

  try {
    const status = await NativeBleScanner.getStatus()
    if (!status.supported) {
      throw new Error('Real beacon testing requires an Android 12+ phone with Bluetooth Low Energy')
    }
    const targets = nativeBeaconTargets(beacons)
    if (!targets.length) throw new Error('No active bus beacons are assigned to your stop')
    await NativeBleScanner.startScan({
      format: 'service_uuid',
      beaconsJson: JSON.stringify(targets),
      minRssi: Number(minRssi),
      timeoutMs
    })
  } catch (error) {
    await dispose()
    throw error
  }

  return {
    stop: async () => {
      await NativeBleScanner.stopScan().catch(() => {})
      await dispose()
    },
    dispose
  }
}

export async function getBackgroundBeaconStatus() {
  if (!supportsNativeBeaconScan()) return { supported: false, backgroundMonitoring: false }
  return NativeBleScanner.getStatus()
}

export async function enableBackgroundBeaconMonitoring({
  beacons,
  minRssi = DEFAULT_BEACON_MIN_RSSI
}) {
  if (!supportsNativeBeaconScan()) {
    throw new Error('Background beacon monitoring is available only in the Android app')
  }
  const targets = nativeBeaconTargets(beacons)
  if (!targets.length) throw new Error('No active bus beacons are assigned to your stop')
  return NativeBleScanner.enableBackgroundScan({
    format: 'service_uuid',
    beaconsJson: JSON.stringify(targets),
    minRssi: Number(minRssi)
  })
}

export async function disableBackgroundBeaconMonitoring() {
  if (!supportsNativeBeaconScan()) return { backgroundMonitoring: false }
  return NativeBleScanner.disableBackgroundScan()
}
