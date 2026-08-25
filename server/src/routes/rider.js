import { Router } from 'express'
import {
  getDb, busById, stopById, busesForStops, sanitizeUser, riderAuthorityBusIds, activeAssignments,
  effectiveStopIdsForUser, dailyStopOverrideForUser, setDailyStopOverride, clearDailyStopOverride,
  pushNotification
} from '../db.js'
import { authenticate, requireRole } from '../auth.js'
import {
  snapshot, passedStopIdsFor, promptsForUser, applySoftHold, applyBleResponse,
  hasBoardedToday, tripStatesForUser, applyAvailableOverride, logRejectedBoarded,
  releaseSoftHold, ensureSingleOptionAutoHold, broadcastAll
} from '../services/occupancy.js'
import { submitDetection } from '../services/bleGateway.js'
import { emitToUser } from '../realtime.js'

const router = Router()
router.use(authenticate, requireRole('rider'))

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
      return {
        ...snap,
        stopIds: b.stopIds,
        stopNames: b.stopIds.map(id => stopById(id)?.name || id),
        passedStopIds: passedStopIdsFor(b.id),
        inchargeAuthority: authorityBusIds.includes(b.id)
      }
    })
  const states = tripStatesForUser(user.id)
  res.json({
    user: sanitizeUser(user),
    stops: effectiveStopIds.map(id => stopById(id)).filter(Boolean),
    defaultStops: user.stopIds.map(id => stopById(id)).filter(Boolean),
    availableStops: db.stops,
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
    notifications: db.notifications.filter(n => n.userId === user.id).slice(-20).reverse()
  })
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
    if (prompt.userId === user.id && prompt.status === 'pending' && !effectiveStopIds.includes(prompt.stopId)) {
      prompt.status = 'cancelled'
    }
  }
}

function releaseIncompatibleHold(user) {
  const state = tripStatesForUser(user.id).find(item => item.state === 'soft_hold')
  const bus = state ? busById(state.busId) : null
  if (bus && !bus.stopIds.some(stopId => effectiveStopIdsForUser(user).includes(stopId))) {
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

router.post('/ble/simulate', (req, res) => {
  const { busId, stopId } = req.body || {}
  const bus = busById(busId)
  if (!bus) return res.status(404).json({ error: 'Bus not found' })
  const candidates = effectiveStopIdsForUser(req.user).filter(s => bus.stopIds.includes(s))
  if (candidates.length === 0) {
    return res.status(403).json({ error: 'Bus does not pass your effective stop today' })
  }
  const resolvedStopId = stopId && candidates.includes(stopId) ? stopId : candidates[0]
  if (hasBoardedToday(req.user.id, bus.id)) {
    logRejectedBoarded({ userId: req.user.id, busId: bus.id, stopId: resolvedStopId, channel: 'ble_confirmed' })
    return res.status(409).json({ error: `You've already been counted as boarded on ${bus.name} for this trip — one report per rider per trip` })
  }
  const prompt = submitDetection({ userId: req.user.id, busId: bus.id, stopId: resolvedStopId })
  if (!prompt) {
    return res.status(409).json({ error: 'You have already been counted as boarded for this trip' })
  }
  res.json({ ok: true, prompts: promptsForUser(req.user.id) })
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
