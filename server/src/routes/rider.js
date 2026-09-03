import { Router } from 'express'
import {
  getDb, busById, stopById, busesForStops, sanitizeUser, riderAuthorityBusIds, activeAssignments,
  effectiveStopIdsForUser, dailyStopOverrideForUser, setDailyStopOverride, clearDailyStopOverride,
  pushNotification, upsertDeviceToken, deactivateDeviceToken, activeStops, todayKey
} from '../db.js'
import { authenticate, requireRole } from '../auth.js'
import {
  snapshot, passedStopIdsFor, promptsForUser, applySoftHold, applyBleResponse,
  hasBoardedToday, tripStatesForUser, applyAvailableOverride, logRejectedBoarded,
  releaseSoftHold, ensureSingleOptionAutoHold, broadcastAll, activeTripRiderManifest
} from '../services/occupancy.js'
import { submitDetection } from '../services/bleGateway.js'
import { emitToUser } from '../realtime.js'
import { normalizeServiceUuid } from '../beaconIdentity.js'
import { activeTripForBus, isServiceDate } from '../services/trips.js'

const router = Router()
router.use(authenticate, requireRole('rider'))

function validFcmToken(value) {
  return typeof value === 'string' && value.trim().length >= 20 && value.trim().length <= 4096
}

router.post('/device-tokens', (req, res) => {
  const { fcmToken, previousToken, platform = 'android' } = req.body || {}
  if (!validFcmToken(fcmToken)) return res.status(400).json({ error: 'A valid FCM token is required' })
  if (previousToken !== undefined && previousToken !== null && !validFcmToken(previousToken)) {
    return res.status(400).json({ error: 'previousToken must be a valid FCM token' })
  }
  if (platform !== 'android') return res.status(400).json({ error: 'Only Android device tokens are supported' })
  const deviceToken = upsertDeviceToken({
    userId: req.user.id,
    fcmToken: fcmToken.trim(),
    previousToken: previousToken?.trim() || null,
    platform
  })
  res.json({
    deviceToken: {
      id: deviceToken.id,
      platform: deviceToken.platform,
      active: deviceToken.active,
      lastSeenAt: deviceToken.lastSeenAt
    }
  })
})

router.delete('/device-tokens', (req, res) => {
  const { fcmToken } = req.body || {}
  if (!validFcmToken(fcmToken)) return res.status(400).json({ error: 'A valid FCM token is required' })
  const deviceToken = deactivateDeviceToken({
    userId: req.user.id,
    fcmToken: fcmToken.trim(),
    reason: 'logout'
  })
  res.json({ ok: true, deactivated: Boolean(deviceToken) })
})

router.get('/overview', (req, res) => {
  const db = getDb()
  const user = req.user
  ensureSingleOptionAutoHold(user)
  const effectiveStopIds = effectiveStopIdsForUser(user)
  const authorityBusIds = riderAuthorityBusIds(user.id)
  const buses = busesForStops(effectiveStopIds)
    .concat(db.buses.filter(b => authorityBusIds.includes(b.id) && !b.stopIds.some(s => effectiveStopIds.includes(s))))
    .filter((b, i, arr) => arr.findIndex(x => x.id === b.id) === i)
    .map(b => {
      const snap = snapshot().find(s => s.busId === b.id)
      const displayStopIds = snap?.stopSequence?.length ? snap.stopSequence : b.stopIds
      const lastDetection = db.prompts
        .filter(prompt => prompt.userId === user.id && prompt.busId === b.id && prompt.detectionSource !== 'mock')
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]
      return {
        ...snap,
        stopIds: displayStopIds,
        stopNames: displayStopIds.map(id => stopById(id)?.name || id),
        boardingStopIds: snap?.boardingStopSet || [],
        passedStopIds: passedStopIdsFor(b.id),
        bleEligible: b.beacon?.active !== false,
        ...(authorityBusIds.includes(b.id) ? {
          bleDiagnostic: {
            lastDetectedAt: lastDetection?.createdAt || null,
            lastDetectionStatus: lastDetection?.status || 'not_detected'
          }
        } : {}),
        inchargeAuthority: authorityBusIds.includes(b.id)
      }
    })
  const states = tripStatesForUser(user.id)
  res.json({
    user: sanitizeUser(user),
    stops: effectiveStopIds.map(id => stopById(id)).filter(Boolean),
    defaultStops: user.stopIds.map(id => stopById(id)).filter(Boolean),
    availableStops: activeStops(),
    dailyStopOverride: dailyStopOverrideForUser(user.id),
    buses,
    prompts: promptsForUser(user.id),
    softHoldBusIds: states.filter(s => s.state === 'soft_hold').map(s => s.busId),
    boardedBusIds: states.filter(s => s.state === 'seats_occupied').map(s => s.busId),
    authorityBusIds,
    myAssignments: activeAssignments()
      .filter(a => a.riderId === user.id)
      .map(a => ({
        id: a.id,
        scopeType: a.scopeType,
        scopeName: a.scopeType === 'bus'
          ? (busById(a.busId)?.name || a.busId)
          : (stopById(a.stopId)?.name || a.stopId),
        grantedAt: a.grantedAt
      })),
    notifications: db.notifications.filter(n => n.userId === user.id).slice(-20).reverse(),
    serviceDay: isServiceDate(todayKey()),
    activeTripDirection: buses.find(bus => bus.tripStatus === 'active')?.tripDirection || null
  })
})

router.get('/buses/:busId/riders', (req, res) => {
  const bus = busById(req.params.busId)
  if (!bus) return res.status(404).json({ error: 'Bus not found' })
  const effectiveStopIds = effectiveStopIdsForUser(req.user)
  const canView = bus.stopIds.some(stopId => effectiveStopIds.includes(stopId)) ||
    riderAuthorityBusIds(req.user.id).includes(bus.id)
  if (!canView) return res.status(403).json({ error: 'Bus does not serve your effective stop today' })
  const manifest = activeTripRiderManifest(bus.id, req.query.state)
  if (!manifest) return res.status(400).json({ error: 'state must be soft_hold or seats_occupied' })
  res.json({ ...manifest, busName: bus.name })
})

router.post('/soft-hold', (req, res) => {
  const { busId, response } = req.body || {}
  if (!['yes', 'no'].includes(response)) return res.status(400).json({ error: 'Response must be yes or no' })
  const bus = busById(busId)
  if (!bus) return res.status(404).json({ error: 'Bus not found' })
  const effectiveStopIds = effectiveStopIdsForUser(req.user)
  if (!bus.stopIds.some(s => effectiveStopIds.includes(s)) &&
    !riderAuthorityBusIds(req.user.id).includes(bus.id)) {
    return res.status(403).json({ error: 'Bus does not pass your stop' })
  }
  if (response === 'yes' && hasBoardedToday(req.user.id, bus.id)) {
    logRejectedBoarded({ userId: req.user.id, busId: bus.id, stopId: effectiveStopIds[0] || null, channel: 'soft_intent' })
    return res.status(409).json({ error: `You've already been counted as boarded on ${bus.name} for this trip — one report per rider per trip` })
  }
  const result = applySoftHold(req.user, bus, response)
  if (!result.ok) return res.status(result.status || 409).json({ error: result.error })
  res.json({ ok: true, changed: result.changed })
})

router.post('/soft-hold/release', (req, res) => {
  const bus = busById(req.body?.busId)
  if (!bus) return res.status(404).json({ error: 'Bus not found' })
  const result = releaseSoftHold(req.user, bus)
  if (!result.ok) return res.status(result.status || 409).json({ error: result.error })
  res.json({ ok: true, changed: true })
})

function cancelPromptsOutsideEffectiveStop(user) {
  const effectiveStopIds = effectiveStopIdsForUser(user)
  for (const prompt of getDb().prompts) {
    const trip = getDb().trips.find(item => item.id === prompt.tripId)
    const compatible = trip?.direction === 'evening'
      ? trip.stopSequence.some(stopId =>
        !trip.boardingStopSet.includes(stopId) && effectiveStopIds.includes(stopId)
      )
      : effectiveStopIds.includes(prompt.stopId)
    if (prompt.userId === user.id && prompt.status === 'pending' && !compatible) {
      prompt.status = 'cancelled'
    }
  }
}

function releaseIncompatibleHold(user) {
  const state = tripStatesForUser(user.id).find(item => item.state === 'soft_hold')
  const bus = state ? busById(state.busId) : null
  const trip = bus ? activeTripForBus(bus.id) : null
  const effectiveStopIds = effectiveStopIdsForUser(user)
  const compatible = trip?.direction === 'evening'
    ? trip.stopSequence.some(stopId => !trip.boardingStopSet.includes(stopId) && effectiveStopIds.includes(stopId))
    : bus?.stopIds.some(stopId => effectiveStopIds.includes(stopId))
  if (bus && !compatible) {
    releaseSoftHold(user, bus, 'daily_stop_changed')
  }
}

function notifyStopContext(user, stop, restored = false) {
  const message = restored
    ? `Today's boarding stop was reset to your default: ${stop?.name || 'registered stop'}.`
    : `For today only, boarding prompts will use ${stop.name}. Your registered stop is unchanged.`
  const notification = pushNotification(user.id, message, 'stop_override')
  emitToUser(user.id, 'notification', notification)
  emitToUser(user.id, 'prompts', promptsForUser(user.id))
  emitToUser(user.id, 'refresh', { reason: 'daily-stop-context-changed' })
}

router.post('/daily-stop', (req, res) => {
  const stop = stopById(req.body?.stopId)
  if (!stop) return res.status(404).json({ error: 'Stop not found' })
  const override = setDailyStopOverride(req.user.id, stop.id)
  cancelPromptsOutsideEffectiveStop(req.user)
  releaseIncompatibleHold(req.user)
  ensureSingleOptionAutoHold(req.user)
  notifyStopContext(req.user, stop)
  broadcastAll()
  res.json({ ok: true, override, effectiveStop: stop })
})

router.delete('/daily-stop', (req, res) => {
  clearDailyStopOverride(req.user.id)
  cancelPromptsOutsideEffectiveStop(req.user)
  releaseIncompatibleHold(req.user)
  ensureSingleOptionAutoHold(req.user)
  const defaultStop = stopById(req.user.stopIds[0])
  notifyStopContext(req.user, defaultStop, true)
  broadcastAll()
  res.json({ ok: true, effectiveStops: effectiveStopIdsForUser(req.user).map(stopById).filter(Boolean) })
})

function normalizedServiceBeacon(value) {
  const uuid = normalizeServiceUuid(value?.uuid)
  if (value?.format !== 'service_uuid' || !uuid) return null
  return {
    format: 'service_uuid',
    uuid,
    major: null,
    minor: null,
    rssi: Number.isInteger(value.rssi) ? value.rssi : null,
    txPower: Number.isInteger(value.txPower) ? value.txPower : null
  }
}

function handleBleDetectionRequest(req, res, { source, requireBeacon = false }) {
  const { busId, stopId } = req.body || {}
  const beacon = requireBeacon ? normalizedServiceBeacon(req.body?.beacon) : null
  if (requireBeacon && !beacon) {
    return res.status(400).json({ error: 'A valid server-assigned custom BLE service UUID is required' })
  }
  let mappedBus = null
  if (requireBeacon) {
    mappedBus = getDb().buses.find(candidate =>
      candidate.beacon?.active && candidate.beacon.serviceUuid === beacon.uuid)
    if (!mappedBus) {
      return res.status(422).json({
        error: 'This BLE service UUID is not assigned to an active Campus Seatline bus',
        code: 'UNKNOWN_BEACON_UUID'
      })
    }
    if (busId && mappedBus.id !== busId) {
      return res.status(409).json({
        error: `Beacon identity belongs to ${mappedBus.name}, not ${busById(busId)?.name || 'the submitted bus'}`,
        code: 'BEACON_BUS_MISMATCH'
      })
    }
  }
  const bus = requireBeacon ? mappedBus : busById(busId)
  if (!bus) return res.status(404).json({ error: 'Bus not found' })
  const trip = activeTripForBus(bus.id)
  if (!trip) return res.status(409).json({ error: `No active trip for ${bus.name}` })
  const candidates = effectiveStopIdsForUser(req.user).filter(s => bus.stopIds.includes(s))
  if (candidates.length === 0) {
    return res.status(403).json({ error: 'Bus does not pass your effective stop today' })
  }
  const resolvedStopId = stopId && candidates.includes(stopId) ? stopId : candidates[0]
  if (hasBoardedToday(req.user.id, bus.id) && trip.direction !== 'evening') {
    logRejectedBoarded({ userId: req.user.id, busId: bus.id, stopId: resolvedStopId, channel: 'ble_confirmed' })
    return res.status(409).json({ error: `You've already been counted as boarded on ${bus.name} for this trip — one report per rider per trip` })
  }
  const detectionSource = beacon?.format || source
  const prompt = submitDetection({
    source: detectionSource,
    userId: req.user.id,
    busId: bus.id,
    stopId: resolvedStopId,
    beacon
  })
  if (!prompt) {
    return res.status(409).json({ error: 'You have already been counted as boarded for this trip' })
  }
  if (prompt.alighted) {
    return res.json({ ok: true, source: detectionSource, alighted: true, prompts: [] })
  }
  return res.json({ ok: true, source: detectionSource, prompts: promptsForUser(req.user.id) })
}

router.post('/ble/simulate', (req, res) => {
  return handleBleDetectionRequest(req, res, { source: 'mock' })
})

router.post('/ble/detected', (req, res) => {
  return handleBleDetectionRequest(req, res, { source: 'ibeacon', requireBeacon: true })
})

router.post('/prompts/:id/respond', (req, res) => {
  const { response } = req.body || {}
  if (!['yes', 'no'].includes(response)) return res.status(400).json({ error: 'Response must be yes or no' })
  const db = getDb()
  const prompt = db.prompts.find(p => p.id === req.params.id)
  if (!prompt || prompt.userId !== req.user.id) return res.status(404).json({ error: 'Prompt not found' })
  if (prompt.status !== 'pending') return res.status(409).json({ error: `Prompt already ${prompt.status}` })
  if (new Date(prompt.expiresAt).getTime() <= Date.now()) {
    prompt.status = 'expired'
    return res.status(410).json({ error: 'Prompt expired — counts unchanged' })
  }
  const result = applyBleResponse(req.user, prompt, response)
  if (!result.ok) return res.status(result.status || 409).json({ error: result.error })
  res.json({ ok: true, ...result })
})

router.post('/incharge/buses/:busId/available', (req, res) => {
  const bus = busById(req.params.busId)
  if (!bus) return res.status(404).json({ error: 'Bus not found' })
  if (!riderAuthorityBusIds(req.user.id).includes(bus.id)) {
    return res.status(403).json({ error: 'No active Incharge authority for this bus' })
  }
  const available = Number(req.body?.seatsAvailable)
  if (!Number.isInteger(available) || available < 0 || available > bus.capacity) {
    return res.status(400).json({ error: `Seats Available must be an integer between 0 and ${bus.capacity}` })
  }
  const result = applyAvailableOverride(req.user, bus, available)
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error })
  res.json({ ok: true, override: result.entry })
})

router.get('/incharge/buses/:busId/riders', (req, res) => {
  const bus = busById(req.params.busId)
  if (!bus) return res.status(404).json({ error: 'Bus not found' })
  if (!riderAuthorityBusIds(req.user.id).includes(bus.id)) {
    return res.status(403).json({ error: 'No active Incharge authority for this bus' })
  }
  const manifest = activeTripRiderManifest(bus.id, req.query.state)
  if (!manifest) return res.status(400).json({ error: 'state must be soft_hold or seats_occupied' })
  res.json({ ...manifest, busName: bus.name })
})

router.get('/incharge/assignments', (req, res) => {
  res.json({
    assignments: activeAssignments()
      .filter(a => a.riderId === req.user.id)
      .map(a => ({
        id: a.id,
        scopeType: a.scopeType,
        scopeName: a.scopeType === 'bus'
          ? (busById(a.busId)?.name || a.busId)
          : (stopById(a.stopId)?.name || a.stopId),
        grantedAt: a.grantedAt
      }))
  })
})

export default router
