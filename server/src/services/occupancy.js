import {
  getDb, nextId, todayKey, occupancyOf, pushNotification, busById, stopById, userById,
  busesForStops, activeReportForUser, transitionRiderReport, releaseRiderSoftHold,
  effectiveStopIdsForUser, createUnmetDemandEvent
} from '../db.js'
import { emitAdmins, emitAll, emitToUser } from '../realtime.js'
import { auditSnapshot } from './audit.js'

export const PROMPT_TTL_MS = 120000

export { todayKey }

function broadcastAll() {
  emitAll('occupancy', snapshot())
  emitAdmins('audit', auditSnapshot())
}

function syncRiderState(userId) {
  emitToUser(userId, 'prompts', promptsForUser(userId))
  emitToUser(userId, 'refresh', { reason: 'rider-state-changed' })
}

function feedback(userId, message, type = 'feedback') {
  const n = pushNotification(userId, message, type)
  emitToUser(userId, 'notification', n)
}

export function unmetDemandDisplay(event) {
  return {
    ...event,
    riderDisplayName: userById(event.riderId)?.name || event.riderId,
    stopName: stopById(event.stopId)?.name || event.stopId,
    busLabel: busById(event.busId)?.name || event.busId
  }
}

export function captureUnmetDemand({ user, stopId, bus }) {
  if (!user || !stopId || !bus || !bus.stopIds.includes(stopId)) return null
  const servingBuses = busesForStops([stopId])
  if (servingBuses.length === 0) return null

  const currentByBus = new Map(snapshot().map(item => [item.busId, item]))
  if (!servingBuses.every(candidate => (currentByBus.get(candidate.id)?.availableSeats ?? 0) <= 0)) {
    return null
  }

  const event = createUnmetDemandEvent({
    riderId: user.id,
    stopId,
    busId: bus.id,
    availableSeatsAtTime: currentByBus.get(bus.id)?.availableSeats ?? 0
  })
  const payload = unmetDemandDisplay(event)
  emitAdmins('unmet_demand:new', payload)
  return payload
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n))

export function riderTripState(userId, busId) {
  const trip = todayKey()
  return getDb().boardingReports.find(
    r => r.userId === userId && r.busId === busId && r.tripDate === trip
  )
}

function logAttempt({ userId, busId, stopId, channel, requested, outcome, message }) {
  const db = getDb()
  const entry = {
    id: nextId(), userId, busId, stopId: stopId || null,
    tripDate: todayKey(), channel, requested, outcome,
    message: message || null, timestamp: new Date().toISOString()
  }
  db.reportAttempts.push(entry)
  return entry
}

export function logRejectedBoarded({ userId, busId, stopId, channel }) {
  const entry = logAttempt({
    userId, busId, stopId, channel, requested: 'yes',
    outcome: 'rejected_already_boarded',
    message: "You've already been counted as boarded for this trip."
  })
  emitAdmins('audit', auditSnapshot())
  syncRiderState(userId)
  return entry
}

export { broadcastAll }

export function tripCounts(busId) {
  const db = getDb()
  const trip = todayKey()
  const recs = db.boardingReports.filter(r => r.busId === busId && r.tripDate === trip)
  return {
    baseOccupied: recs.filter(r => r.state === 'seats_occupied').length,
    softHolds: recs.filter(r => r.state === 'soft_hold').length
  }
}

export function hasBoardedToday(userId, busId) {
  return riderTripState(userId, busId)?.state === 'seats_occupied'
}

export function activeTripStateForUser(userId) {
  return activeReportForUser(userId)
}

export function tripStatesForUser(userId) {
  const trip = todayKey()
  return getDb().boardingReports
    .filter(r => r.userId === userId && r.tripDate === trip)
    .map(r => ({ busId: r.busId, tripDate: r.tripDate, state: r.state }))
}

export function snapshot() {
  const db = getDb()
  return db.buses.map(bus => {
    const occ = occupancyOf(bus.id)
    const { baseOccupied, softHolds } = tripCounts(bus.id)
    const seatsOccupied = clamp(baseOccupied + occ.manualAdjustment, 0, bus.capacity)
    return {
      busId: bus.id,
      busName: bus.name,
      capacity: bus.capacity,
      tripDate: occ.tripDate,
      baseOccupied,
      manualAdjustment: occ.manualAdjustment,
      seatsOccupied,
      softHolds,
      availableSeats: clamp(bus.capacity - seatsOccupied - softHolds, 0, bus.capacity),
      lastUpdated: occ.lastUpdated
    }
  })
}

export function passedStopIdsFor(busId) {
  const trip = todayKey()
  return getDb().arrivalEvents.filter(e => e.busId === busId && e.tripDate === trip).map(e => e.stopId)
}

function logHoldRelease(userId, released, channel, outcome, message = null) {
  if (!released) return
  logAttempt({
    userId,
    busId: released.busId,
    stopId: released.stopId,
    channel,
    requested: 'release',
    outcome,
    message
  })
  occupancyOf(released.busId).lastUpdated = new Date().toISOString()
}

export function applySoftHold(user, bus, response, { source = 'manual', stopId: requestedStopId } = {}) {
  const now = new Date().toISOString()
  const stopId = requestedStopId || effectiveStopIdsForUser(user)[0] || null

  if (response === 'yes') {
    const active = activeTripStateForUser(user.id)
    if (active?.state === 'seats_occupied') {
      const activeBus = busById(active.busId)
      logAttempt({
        userId: user.id, busId: bus.id, stopId, channel: 'soft_intent', requested: 'yes',
        outcome: 'rejected_already_boarded',
        message: `Already occupied on ${activeBus?.name || active.busId}`
      })
      feedback(user.id, `You've already been counted as boarded on ${activeBus?.name || 'a bus'} for this trip — no additional report was added.`)
      broadcastAll()
      syncRiderState(user.id)
      return { ok: false, status: 409, error: `You've already been counted as boarded on ${activeBus?.name || 'a bus'} for this trip` }
    }
    if (active?.state === 'soft_hold' && active.busId === bus.id) {
      logAttempt({
        userId: user.id, busId: bus.id, stopId, channel: 'soft_intent', requested: 'yes',
        outcome: 'no_change', message: 'Soft hold already active'
      })
      feedback(user.id, `You already have an active soft hold for ${bus.name} this trip.`)
      broadcastAll()
      syncRiderState(user.id)
      return { ok: true, changed: false }
    }

    const current = snapshot().find(item => item.busId === bus.id)
    if (!current || current.availableSeats <= 0) {
      logAttempt({
        userId: user.id, busId: bus.id, stopId, channel: 'soft_intent', requested: 'yes',
        outcome: 'rejected_no_availability', message: 'No seats are currently available'
      })
      feedback(user.id, `${bus.name} currently has no seats available, so a Soft Hold was not added.`, 'error')
      captureUnmetDemand({ user, stopId, bus })
      broadcastAll()
      syncRiderState(user.id)
      return { ok: false, status: 409, error: `${bus.name} currently has no seats available` }
    }

    const transition = transitionRiderReport({
      userId: user.id, busId: bus.id, stopId, toState: 'soft_hold', source
    })
    if (!transition.ok) {
      return { ok: false, status: 409, error: 'Your trip report state changed. Refresh and try again.' }
    }

    logHoldRelease(
      user.id,
      transition.released,
      'soft_hold_release',
      'accepted_transfer_release',
      `Transferred Soft Hold to ${bus.name}`
    )
    occupancyOf(bus.id).lastUpdated = now
    logAttempt({
      userId: user.id, busId: bus.id, stopId,
      channel: source === 'auto' ? 'auto_soft_hold' : 'soft_intent', requested: 'yes',
      outcome: transition.released ? 'accepted_soft_hold_transfer' :
        source === 'auto' ? 'accepted_auto_soft_hold' : 'accepted_new_soft_hold'
    })
    const snap = snapshot().find(s => s.busId === bus.id)
    if (source === 'auto') {
      feedback(user.id, `You've been automatically soft-held on ${bus.name} (your only bus option today) — tap Release if you're not traveling.`, 'auto_hold')
    } else if (transition.released) {
      feedback(user.id, `Your Soft Hold moved to ${bus.name} — ${snap.availableSeats} seats effectively remaining.`)
    } else {
      feedback(user.id, `Soft hold placed for ${bus.name} — ${snap.availableSeats} seats effectively remaining.`)
    }
  } else {
    logAttempt({
      userId: user.id, busId: bus.id, stopId, channel: 'soft_intent', requested: 'no',
      outcome: 'no_change'
    })
    feedback(user.id, `Noted — you were not added to ${bus.name}. Counts unchanged.`)
  }

  broadcastAll()
  syncRiderState(user.id)
  return { ok: true, changed: response === 'yes' }
}

export function releaseSoftHold(user, bus, reason = 'rider_release') {
  const released = releaseRiderSoftHold({ userId: user.id, busId: bus.id, reason })
  if (!released.ok) {
    return { ok: false, status: 409, error: `You do not have an active Soft Hold on ${bus.name}` }
  }
  logHoldRelease(user.id, { ...released.record }, 'soft_hold_release', 'accepted_release')
  feedback(user.id, `Your Soft Hold on ${bus.name} was released. Counts are updated.`, 'feedback')
  broadcastAll()
  syncRiderState(user.id)
  return { ok: true, changed: true }
}

export function ensureSingleOptionAutoHold(user) {
  const db = getDb()
  const tripDate = todayKey()
  const effectiveStopIds = effectiveStopIdsForUser(user)
  const contextKey = [...effectiveStopIds].sort().join(':')
  const existing = db.autoHoldEvaluations.find(
    item => item.userId === user.id && item.tripDate === tripDate && item.contextKey === contextKey
  )
  if (existing) return existing

  const viableBuses = busesForStops(effectiveStopIds)
  const evaluation = {
    id: nextId(), userId: user.id, tripDate,
    contextKey,
    stopIds: [...effectiveStopIds], viableBusIds: viableBuses.map(bus => bus.id),
    outcome: viableBuses.length === 1 ? 'eligible' : 'not_single_option',
    createdAt: new Date().toISOString()
  }
  db.autoHoldEvaluations.push(evaluation)

  if (viableBuses.length !== 1 || activeTripStateForUser(user.id)) return evaluation
  const result = applySoftHold(user, viableBuses[0], 'yes', {
    source: 'auto', stopId: effectiveStopIds[0] || null
  })
  evaluation.outcome = result.ok && result.changed ? 'created' : 'not_created'
  evaluation.error = result.ok ? null : result.error
  return evaluation
}

function downstreamRecipients(bus, stopId) {
  const db = getDb()
  const idx = bus.stopIds.indexOf(stopId)
  if (idx === -1) return []
  const downstream = bus.stopIds.slice(idx + 1)
  return db.users
    .filter(u => effectiveStopIdsForUser(u).some(s => downstream.includes(s)))
    .map(u => u.id)
}

function inchargeIdsForStop(bus, stopId) {
  const db = getDb()
  return db.inchargeAssignments
    .filter(a => !a.revokedAt &&
      ((a.scopeType === 'bus' && a.busId === bus.id) ||
        (a.scopeType === 'stop' && a.stopId === stopId)))
    .map(a => a.riderId)
}

export function applyBleResponse(user, prompt, response) {
  const db = getDb()
  const bus = busById(prompt.busId)
  const stop = stopById(prompt.stopId)
  const now = new Date().toISOString()
  const finish = result => {
    broadcastAll()
    syncRiderState(user.id)
    return result
  }

  if (!bus || !stop || user.role !== 'rider' || !effectiveStopIdsForUser(user).includes(stop.id) || !bus.stopIds.includes(stop.id)) {
    prompt.status = 'cancelled'
    logAttempt({
      userId: user.id, busId: prompt.busId, stopId: prompt.stopId,
      channel: 'ble_confirmed', requested: response,
      outcome: 'rejected_invalid_detection',
      message: 'The rider, bus and stop no longer form a valid BLE reporting context'
    })
    feedback(user.id, 'This boarding prompt is no longer valid. Counts were not changed.', 'error')
    return finish({
      ok: false, status: 409,
      error: 'This boarding prompt is no longer valid',
      promoted: false, arrivalCreated: false
    })
  }

  prompt.status = 'answered'

  if (response === 'yes' && hasBoardedToday(user.id, bus.id)) {
    logAttempt({
      userId: user.id, busId: bus.id, stopId: stop.id, channel: 'ble_confirmed', requested: 'yes',
      outcome: 'rejected_already_boarded',
      message: "You've already been counted as boarded for this trip."
    })
    feedback(user.id, `You've already been counted as boarded on ${bus.name} for this trip — no double count.`)
    return finish({
      ok: false, status: 409,
      error: `You've already been counted as boarded on ${bus.name} for this trip`,
      promoted: false, arrivalCreated: false, duplicate: true
    })
  }

  const otherActive = response === 'yes' ? activeTripStateForUser(user.id) : null
  if (otherActive?.state === 'seats_occupied' && otherActive.busId !== bus.id) {
    const otherBus = busById(otherActive.busId)
    logAttempt({
      userId: user.id, busId: bus.id, stopId: stop.id, channel: 'ble_confirmed', requested: 'yes',
      outcome: 'rejected_already_boarded',
      message: `Already occupied on ${otherBus?.name || otherActive.busId}`
    })
    feedback(
      user.id,
      `You've already been counted as boarded on ${otherBus?.name || 'another bus'} for this trip — no double count.`
    )
    return finish({
      ok: false, status: 409,
      error: `You've already been counted as boarded on ${otherBus?.name || 'another bus'} for this trip`,
      promoted: false, arrivalCreated: false, duplicate: true
    })
  }

  if (response !== 'yes') {
    logAttempt({
      userId: user.id, busId: bus.id, stopId: stop.id, channel: 'ble_confirmed', requested: 'no',
      outcome: 'no_change'
    })
    feedback(user.id, `Response recorded for ${bus.name} — counts unchanged.`)
    return finish({ ok: true, promoted: false, arrivalCreated: false })
  }

  const sameBusHold = otherActive?.state === 'soft_hold' && otherActive.busId === bus.id
  if (!sameBusHold) {
    const current = snapshot().find(item => item.busId === bus.id)
    if (!current || current.availableSeats <= 0) {
      logAttempt({
        userId: user.id, busId: bus.id, stopId: stop.id,
        channel: 'ble_confirmed', requested: 'yes',
        outcome: 'rejected_no_availability', message: 'No seats are currently available'
      })
      feedback(user.id, `${bus.name} currently has no seats available, so you were not added.`, 'error')
      captureUnmetDemand({ user, stopId: stop.id, bus })
      return finish({
        ok: false, status: 409, error: `${bus.name} currently has no seats available`,
        promoted: false, arrivalCreated: false
      })
    }
  }
  const transition = transitionRiderReport({
    userId: user.id,
    busId: bus.id,
    stopId: stop.id,
    toState: 'seats_occupied',
    source: 'ble_confirmed'
  })
  if (!transition.ok) {
    feedback(user.id, 'Your trip report state changed before this response completed. Counts were not changed.', 'error')
    return finish({
      ok: false, status: 409, error: 'Your trip report state changed. Refresh and try again.',
      promoted: false, arrivalCreated: false, duplicate: true
    })
  }
  const promoted = Boolean(transition.promoted)
  if (transition.released) {
    logHoldRelease(
      user.id,
      transition.released,
      'soft_hold_release',
      'accepted_transfer_release',
      `Released during BLE boarding on ${bus.name}`
    )
  }
  occupancyOf(bus.id).lastUpdated = now

  logAttempt({
    userId: user.id, busId: bus.id, stopId: stop.id, channel: 'ble_confirmed', requested: 'yes',
    outcome: promoted ? 'accepted_promotion' :
      transition.released ? 'accepted_transfer_direct_boarding' : 'accepted_direct_boarding'
  })

  let event = db.arrivalEvents.find(e =>
    e.busId === bus.id && e.stopId === stop.id && e.tripDate === todayKey()
  )
  let arrivalCreated = false
  if (!event) {
    event = { id: nextId(), busId: bus.id, stopId: stop.id, confirmedByUserIds: [], timestamp: now, tripDate: todayKey() }
    db.arrivalEvents.push(event)
    arrivalCreated = true
  }
  if (!event.confirmedByUserIds.includes(user.id)) event.confirmedByUserIds.push(user.id)

  const snap = snapshot().find(s => s.busId === bus.id)
  feedback(user.id, `You're now counted as Seats Occupied — ${snap.availableSeats} seats remaining on ${bus.name}.`)

  if (arrivalCreated) {
    const recipients = new Set(downstreamRecipients(bus, stop.id))
    for (const ic of inchargeIdsForStop(bus, stop.id)) recipients.add(ic)
    recipients.delete(user.id)
    for (const uid of recipients) {
      const n = pushNotification(uid, `Bus ${bus.name} has reported at ${stop.name}.`, 'arrival')
      emitToUser(uid, 'notification', n)
    }
    emitAdmins('arrival', {
      id: event.id, busId: bus.id, busName: bus.name,
      stopId: stop.id, stopName: stop.name, timestamp: now
    })
  }

  return finish({
    ok: true,
    promoted,
    arrivalCreated,
    transferredFromBusId: transition.released?.busId || null
  })
}

export function promptsForUser(userId) {
  const db = getDb()
  const now = Date.now()
  const user = userById(userId)
  const effectiveStopIds = user ? effectiveStopIdsForUser(user) : []
  return db.prompts
    .filter(p => p.userId === userId && p.tripDate === todayKey() &&
      effectiveStopIds.includes(p.stopId) && p.status === 'pending' && new Date(p.expiresAt).getTime() > now)
    .map(p => ({
      ...p,
      busName: busById(p.busId)?.name || p.busId,
      stopName: stopById(p.stopId)?.name || p.stopId
    }))
}

export function expirePrompt(promptId) {
  const db = getDb()
  const p = db.prompts.find(x => x.id === promptId)
  if (!p || p.status !== 'pending') return
  if (new Date(p.expiresAt).getTime() > Date.now()) return
  p.status = 'expired'
  feedback(p.userId, 'Boarding confirmation window expired — counts unchanged.', 'info')
  emitToUser(p.userId, 'prompts', promptsForUser(p.userId))
}

export function handleDetection({ userId, busId, stopId }) {
  const db = getDb()
  const user = userById(userId)
  const bus = busById(busId)
  const stop = stopById(stopId)
  if (!user || !bus || !stop || user.role !== 'rider' ||
    !effectiveStopIdsForUser(user).includes(stop.id) || !bus.stopIds.includes(stop.id)) {
    throw new Error('Invalid detection payload: rider, bus and effective stop must match')
  }

  if (hasBoardedToday(userId, busId)) {
    feedback(userId, `You've already been counted as boarded on ${bus.name} for this trip.`)
    return null
  }

  const otherActive = activeTripStateForUser(userId)
  if (otherActive?.state === 'seats_occupied' && otherActive.busId !== busId) {
    const otherBus = busById(otherActive.busId)
    feedback(
      userId,
      `You've already been counted as boarded on ${otherBus?.name || 'another bus'} for this trip.`
    )
    return null
  }

  const now = Date.now()
  const existing = db.prompts.find(p =>
    p.userId === userId && p.busId === busId && p.stopId === stopId &&
    p.status === 'pending' && new Date(p.expiresAt).getTime() > now
  )
  if (existing) return existing

  const prompt = {
    id: nextId(), userId, busId, stopId, kind: 'ble_confirm',
    status: 'pending', tripDate: todayKey(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PROMPT_TTL_MS).toISOString()
  }
  db.prompts.push(prompt)
  setTimeout(() => expirePrompt(prompt.id), PROMPT_TTL_MS + 300)

  const n = pushNotification(userId, `Have you boarded ${bus.name} at ${stop.name}?`, 'prompt')
  emitToUser(userId, 'notification', n)
  emitToUser(userId, 'prompts', promptsForUser(userId))
  return prompt
}

export function applyAvailableOverride(incharge, bus, seatsAvailable) {
  const db = getDb()
  const now = new Date().toISOString()

  const { baseOccupied, softHolds } = tripCounts(bus.id)
  const maximumAvailable = bus.capacity - softHolds
  if (!Number.isInteger(seatsAvailable) || seatsAvailable < 0 || seatsAvailable > maximumAvailable) {
    return {
      ok: false,
      status: 400,
      error: `Seats Available must be an integer between 0 and ${maximumAvailable} while ${softHolds} Soft Hold${softHolds === 1 ? ' is' : 's are'} active`
    }
  }
  const occ = occupancyOf(bus.id)
  const previousOccupied = clamp(baseOccupied + occ.manualAdjustment, 0, bus.capacity)
  const previousAvailable = clamp(bus.capacity - previousOccupied - softHolds, 0, bus.capacity)

  const targetOccupied = clamp(bus.capacity - seatsAvailable - softHolds, 0, bus.capacity)
  occ.manualAdjustment = targetOccupied - baseOccupied
  occ.lastUpdated = now

  const entry = {
    id: nextId(), inchargeId: incharge.id, busId: bus.id, tripDate: todayKey(),
    previousAvailable, newAvailable: seatsAvailable,
    previousOccupied, newOccupied: targetOccupied, timestamp: now
  }
  db.overrides.push(entry)

  feedback(
    incharge.id,
    `Seats Available for ${bus.name} set to ${seatsAvailable} — Seats Occupied recalculated to ${targetOccupied}.`
  )
  broadcastAll()
  return { ok: true, entry }
}
