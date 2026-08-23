let detectionHandler = null

export function onDetection(handler) {
  detectionHandler = handler
}

export function submitDetection(event) {
  if (!detectionHandler) throw new Error('No BLE detection handler registered')
  return detectionHandler({ source: 'mock', detectedAt: new Date().toISOString(), ...event })
}
