import {
  getDb, nextId, todayKey, pushNotification, busById, stopById, userById,
  activeReportForUser, transitionRiderReport, releaseRiderSoftHold,
  effectiveStopIdsForUser, runDatabaseTransaction, activeBuses
} from '../db.js'
import { emitAdmins, emitAll, emitToUser } from '../realtime.js'
import { auditSnapshot } from './audit.js'
import { sendPushIfUserOffline, sendPushToUser } from './push.js'
import { recordUnmetDemand } from './unmetDemand.js'
import {
  activeTripForBus, activeTripsForService, countsForTrip, currentServicePeriod,
  tripById, tripOccupancyOf
} from './trips.js'

export const PROMPT_TTL_MS = 120000

export { todayKey }

function broadcastAll() {
  emitAll('occupancy', snapshot())
  emitAll('refresh', { reason: 'occupancy-or-crossing-changed' })
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

const clamp = (n, min, max) => Math.min(max, Math.max(min, n))

function riderContextForTrip(user, trip) {
  if (!user || !trip) return { eligible: false, boardingStopId: null, alightStopId: null }
  const effectiveStopIds = effectiveStopIdsForUser(user, trip.date)
  if (trip.direction === 'morning') {
    const boardingStopId = trip.boardingStopSet.find(stopId => effectiveStopIds.includes(stopId)) || null
    return { eligible: Boolean(boardingStopId), boardingStopId, alightStopId: null }
  }
  const boardingStopId = trip.boardingStopSet[0] || null
  const alightStopId = trip.stopSequence.find(stopId =>
    stopId !== boardingStopId && effectiveStopIds.includes(stopId)
  ) || null
  return { eligible: Boolean(boardingStopId && alightStopId), boardingStopId, alightStopId }
}

function touchTrip(trip) {
  if (trip) tripOccupancyOf(trip.id).lastUpdated = new Date().toISOString()
}

export function riderTripState(userId, busId) {
  const trip = activeTripForBus(busId)
  if (!trip) return null
  return getDb().boardingReports.find(
    report => report.userId === userId && report.tripId === trip.id
  ) || null
}

function logAttempt({ userId, trip, busId, stopId, channel, requested, outcome, message }) {
  const db = getDb()
  const resolvedTrip = trip || activeTripForBus(busId)
  const entry = {
    id: nextId(), userId, tripId: resolvedTrip?.id || null,
    busId: resolvedTrip?.busId || busId, stopId: stopId || null,
    tripDate: resolvedTrip?.date || todayKey(), tripDirection: resolvedTrip?.direction || 'morning',
    channel, requested, outcome,
    message: message || null, timestamp: new Date().toISOString()
  }
  db.reportAttempts.push(entry)
  return entry
}

export function logRejectedBoarded({ userId, busId, stopId, channel }) {
  const trip = activeTripForBus(busId)
  const entry = logAttempt({
    userId, trip, busId, stopId, channel, requested: 'yes',
    outcome: 'rejected_already_boarded',
    message: "You've already been counted as boarded for this trip."
  })
  emitAdmins('audit', auditSnapshot())
  syncRiderState(userId)
  return entry
}

export { broadcastAll }

export function tripCounts(busId) {
  const trip = activeTripForBus(busId)
  if (!trip) return { baseOccupied: 0, softHolds: 0 }
  const { baseOccupied, softHolds } = countsForTrip(trip)
  return { baseOccupied, softHolds }
}

export function hasBoardedToday(userId, busId) {
  return riderTripState(userId, busId)?.state === 'seats_occupied'
}

export function activeTripStateForUser(userId) {
  const period = currentServicePeriod()
  return period ? activeReportForUser(userId, period.date, period.direction) : null
}

export function tripStatesForUser(userId) {
  const period = currentServicePeriod()
  if (!period) return []
  return getDb().boardingReports
    .filter(report => report.userId === userId && report.tripDate === period.date &&
      report.tripDirection === period.direction)
    .map(report => ({
      tripId: report.tripId, busId: report.busId, tripDate: report.tripDate,
      tripDirection: report.tripDirection, state: report.state,
      alightStopId: report.alightStopId || null
    }))
}

export function snapshot() {
  const db = getDb()
  const today = todayKey()
  return activeBuses().map(bus => {
    const activeTrip = activeTripForBus(bus.id)
    const displayTrip = activeTrip || db.trips.find(trip =>
      trip.busId === bus.id && trip.date === today && trip.status === 'scheduled'
    ) || null
    const counts = activeTrip ? countsForTrip(activeTrip) : {
      baseOccupied: 0, softHolds: 0, manualAdjustment: 0, seatsOccupied: 0, availableSeats: 0
    }
    return {
      busId: bus.id,
      busName: bus.name,
      capacity: bus.capacity,
      tripId: displayTrip?.id || null,
      tripDate: displayTrip?.date || today,
      tripDirection: displayTrip?.direction || null,
      tripStatus: displayTrip?.status || 'not_scheduled',
      stopSequence: displayTrip?.stopSequence || [],
      boardingStopSet: displayTrip?.boardingStopSet || [],
      baseOccupied: counts.baseOccupied,
      manualAdjustment: counts.manualAdjustment,
      seatsOccupied: counts.seatsOccupied,
      softHolds: counts.softHolds,
      availableSeats: counts.availableSeats,
      lastUpdated: activeTrip ? tripOccupancyOf(activeTrip.id).lastUpdated : null
    }
  })
}

export function passedStopIdsFor(busId) {
  const trip = activeTripForBus(busId)
  if (!trip) return []
  return getDb().arrivalEvents.filter(event => event.tripId === trip.id).map(event => event.stopId)
}

function logHoldRelease(userId, released, channel, outcome, message = null) {
  if (!released) return
  logAttempt({
    userId,
    trip: tripById(released.tripId),
    busId: released.busId,
    stopId: released.stopId,
    channel,
    requested: 'release',
    outcome,
    message
  })
  touchTrip(tripById(released.tripId))
}

function viableTripsForUser(user, period = currentServicePeriod()) {
  if (!period) return []
  return getDb().trips
    .filter(trip => trip.date === period.date && trip.direction === period.direction && trip.status !== 'completed')
    .filter(trip => riderContextForTrip(user, trip).eligible)
}

function recordCapacityRejection({ user, trip, stopId, channel }) {
  if (!trip || !stopId || !stopById(stopId)) return null
  const alternateBusIds = viableAlternateBusIds(user, trip)
  return recordUnmetDemand({
    userId: user.id,
    trip,
    stopId,
    busId: trip.busId,
    channel,
    alternateBusIds
  })
}

function viableAlternateBusIds(user, excludedTrip) {
  return activeTripsForService(excludedTrip.date, excludedTrip.direction)
    .filter(trip => riderContextForTrip(user, trip).eligible)
    .filter(candidate => candidate.id !== excludedTrip.id && countsForTrip(candidate).availableSeats > 0)
    .map(candidate => candidate.busId)
}

function ensureInferredCrossingDemand(trip, stopId) {
  const db = getDb()
  const unresolvedHolds = db.boardingReports.filter(report =>
    report.tripId === trip.id && report.stopId === stopId && report.state === 'soft_hold'
  )
  for (const report of unresolvedHolds) {
    const alreadyRecorded = db.unmetDemandEvents.some(event =>
      event.userId === report.userId && event.tripId === trip.id && event.stopId === stopId &&
      event.channel === 'inferred_stop_crossing'
    )
    if (alreadyRecorded) continue
    const user = userById(report.userId)
    recordUnmetDemand({
      userId: report.userId,
      trip,
      stopId,
      busId: trip.busId,
      channel: 'inferred_stop_crossing',
      alternateBusIds: user ? viableAlternateBusIds(user, trip) : []
    })
  }
}

function inferPriorStopCrossings(trip, confirmedStopId, timestamp) {
  const db = getDb()
  const confirmedIndex = trip.boardingStopSet.indexOf(confirmedStopId)
  if (confirmedIndex <= 0) return []

  const inferredStopIds = []
  for (const stopId of trip.boardingStopSet.slice(0, confirmedIndex)) {
    let event = db.arrivalEvents.find(item =>
      item.tripId === trip.id && item.stopId === stopId
    )
    if (!event) {
      event = {
        id: nextId(), tripId: trip.id, busId: trip.busId, stopId,
        tripDate: trip.date, tripDirection: trip.direction, timestamp,
        inferred: true, inferredFromStopId: confirmedStopId, confirmedByUserIds: []
      }
      db.arrivalEvents.push(event)
      inferredStopIds.push(stopId)
    }
    if (event.inferred) ensureInferredCrossingDemand(trip, stopId)
  }
  return inferredStopIds
}
export function applySoftHold(user, bus, response, { source = 'manual', stopId: requestedStopId } = {}) {
  const trip = activeTripForBus(bus.id)
  if (!trip) return { ok: false, status: 409, error: `No active trip for ${bus.name}` }
  const context = riderContextForTrip(user, trip)
  if (!context.eligible) {
    return { ok: false, status: 403, error: `${bus.name} does not serve your stop on this trip` }
  }
  const now = new Date().toISOString()
  const stopId = context.boardingStopId

  if (response === 'yes') {
    const active = activeReportForUser(user.id, trip)
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
      recordCapacityRejection({ user, trip, stopId, channel: 'soft_intent' })
      feedback(user.id, `${bus.name} currently has no seats available, so a Soft Hold was not added.`, 'error')
      broadcastAll()
      syncRiderState(user.id)
      return { ok: false, status: 409, error: `${bus.name} currently has no seats available` }
    }

    const transition = transitionRiderReport({
      userId: user.id, trip, stopId, alightStopId: context.alightStopId,
      toState: 'soft_hold', source
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
    touchTrip(trip)
    logAttempt({
      userId: user.id, busId: bus.id, stopId,
      channel: source === 'auto' ? 'auto_soft_hold' : 'soft_intent', requested: 'yes',
      outcome: transition.released ? 'accepted_soft_hold_transfer' :
        source === 'auto' ? 'accepted_auto_soft_hold' : 'accepted_new_soft_hold'
    })
    const snap = snapshot().find(s => s.busId === bus.id)
    if (source === 'auto') {
      feedback(user.id, `You've been automatically soft-held on ${bus.name}, your only ${trip.direction} trip option — tap Release if you're not traveling.`, 'auto_hold')
      void sendPushIfUserOffline({
        userId: user.id,
        title: `Soft Hold on ${bus.name}`,
        body: `You've been automatically held on your only ${trip.direction} trip option. Open Seatline to release it if you're not travelling.`,
        data: {
          event_type: 'soft_hold_prompt',
          event_id: transition.record.id,
          trip_id: trip.id,
          trip_direction: trip.direction,
          bus_id: bus.id,
          stop_id: stopId
        }
      })
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
  const held = getDb().boardingReports.find(report =>
    report.userId === user.id && report.busId === bus.id && report.state === 'soft_hold'
  )
  const trip = held ? tripById(held.tripId) : activeTripForBus(bus.id)
  const released = releaseRiderSoftHold({ userId: user.id, trip, reason })
  if (!released.ok) {
    return { ok: false, status: 409, error: `You do not have an active Soft Hold on ${bus.name}` }
  }
  logHoldRelease(user.id, { ...released.record }, 'soft_hold_release', 'accepted_release')
  feedback(user.id, `Your Soft Hold on ${bus.name} was released. Counts are updated.`, 'feedback')
  broadcastAll()
  syncRiderState(user.id)
  return { ok: true, changed: true }
}

export function ensureSingleOptionAutoHold(user, requestedPeriod = null) {
  const db = getDb()
  const period = requestedPeriod || currentServicePeriod()
  if (!period) return null
  const tripDate = period.date
  const effectiveStopIds = effectiveStopIdsForUser(user, tripDate)
  const contextKey = [...effectiveStopIds].sort().join(':')
  const existing = db.autoHoldEvaluations.find(
    item => item.userId === user.id && item.tripDate === tripDate &&
      item.tripDirection === period.direction && item.contextKey === contextKey
  )
  if (existing) {
    if (existing.outcome !== 'eligible_waiting_for_activation') return existing
    const waitingTrip = getDb().trips.find(trip =>
      trip.date === period.date && trip.direction === period.direction &&
      existing.viableBusIds.includes(trip.busId) && trip.status === 'active'
    )
    const waitingBus = waitingTrip ? busById(waitingTrip.busId) : null
    if (!waitingBus || activeReportForUser(user.id, period.date, period.direction)) return existing
    const result = applySoftHold(user, waitingBus, 'yes', { source: 'auto' })
    existing.outcome = result.ok && result.changed ? 'created' : 'not_created'
    existing.error = result.ok ? null : result.error
    return existing
  }

  const viableTrips = viableTripsForUser(user, period)
  const viableBuses = viableTrips.map(trip => busById(trip.busId)).filter(Boolean)
  const evaluation = {
    id: nextId(), userId: user.id, tripDate, tripDirection: period.direction,
    contextKey,
    stopIds: [...effectiveStopIds], viableBusIds: viableBuses.map(bus => bus.id),
    outcome: viableBuses.length === 1 ? 'eligible' : 'not_single_option',
    createdAt: new Date().toISOString()
  }
  db.autoHoldEvaluations.push(evaluation)

  if (viableBuses.length !== 1 || activeReportForUser(user.id, period.date, period.direction)) return evaluation
  const activeViableTrip = viableTrips.find(trip => trip.status === 'active')
  if (!activeViableTrip) {
    evaluation.outcome = 'eligible_waiting_for_activation'
    return evaluation
  }
  const result = applySoftHold(user, busById(activeViableTrip.busId), 'yes', {
    source: 'auto', stopId: effectiveStopIds[0] || null
  })
  evaluation.outcome = result.ok && result.changed ? 'created' : 'not_created'
  evaluation.error = result.ok ? null : result.error
  return evaluation
}

export function ensureAutoHoldsForActiveService(activatedTrip = null) {
  const period = activatedTrip
    ? { date: activatedTrip.date, direction: activatedTrip.direction }
    : currentServicePeriod()
  if (!period) return []
  return getDb().users
    .filter(user => user.active !== false && user.role === 'rider')
    .map(user => ensureSingleOptionAutoHold(user, period))
    .filter(Boolean)
}

function downstreamRecipients(trip, stopId) {
  const db = getDb()
  const idx = trip.boardingStopSet.indexOf(stopId)
  if (idx === -1) return []
  const downstream = trip.boardingStopSet.slice(idx + 1)
  return db.users
    .filter(user => user.active !== false && downstream.includes(riderContextForTrip(user, trip).boardingStopId))
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
  const trip = tripById(prompt.tripId)
  const bus = busById(prompt.busId)
  const stop = stopById(prompt.stopId)
  const context = riderContextForTrip(user, trip)
  const now = new Date().toISOString()
  const finish = result => {
    broadcastAll()
    syncRiderState(user.id)
    return result
  }

  if (!trip || trip.status !== 'active' || !bus || !stop || user.role !== 'rider' ||
    !context.eligible || context.boardingStopId !== stop.id || !trip.boardingStopSet.includes(stop.id)) {
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

  const otherActive = response === 'yes' ? activeReportForUser(user.id, trip) : null
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
      recordCapacityRejection({ user, trip, stopId: stop.id, channel: 'ble_confirmed' })
      feedback(user.id, `${bus.name} currently has no seats available, so you were not added.`, 'error')
      return finish({
        ok: false, status: 409, error: `${bus.name} currently has no seats available`,
        promoted: false, arrivalCreated: false
      })
    }
  }
  const transition = transitionRiderReport({
    userId: user.id,
    trip,
    stopId: stop.id,
    alightStopId: context.alightStopId,
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
  touchTrip(trip)

  logAttempt({
    userId: user.id, busId: bus.id, stopId: stop.id, channel: 'ble_confirmed', requested: 'yes',
    outcome: promoted ? 'accepted_promotion' :
      transition.released ? 'accepted_transfer_direct_boarding' : 'accepted_direct_boarding'
  })

  let event = db.arrivalEvents.find(e =>
    e.tripId === trip.id && e.stopId === stop.id
  )
  let arrivalCreated = false
  if (!event) {
    event = {
      id: nextId(), tripId: trip.id, busId: bus.id, stopId: stop.id, confirmedByUserIds: [],
      timestamp: now, tripDate: trip.date, tripDirection: trip.direction,
      inferred: false, inferredFromStopId: null
    }
    db.arrivalEvents.push(event)
    arrivalCreated = true
  } else if (event.inferred) {
    event.inferred = false
    event.inferredFromStopId = null
    event.timestamp = now
    arrivalCreated = true
  }
  if (!event.confirmedByUserIds.includes(user.id)) event.confirmedByUserIds.push(user.id)
  const inferredStopIds = inferPriorStopCrossings(trip, stop.id, now)

  const snap = snapshot().find(s => s.busId === bus.id)
  feedback(user.id, `You're now counted as Seats Occupied — ${snap.availableSeats} seats remaining on ${bus.name}.`)

  if (arrivalCreated) {
    const recipients = new Set(downstreamRecipients(trip, stop.id))
    for (const ic of inchargeIdsForStop(bus, stop.id)) recipients.add(ic)
    recipients.delete(user.id)
    for (const uid of recipients) {
      const n = pushNotification(uid, `Bus ${bus.name} has reported at ${stop.name}.`, 'arrival')
      emitToUser(uid, 'notification', n)
      void sendPushIfUserOffline({
        userId: uid,
        title: `${bus.name} reported at ${stop.name}`,
        body: 'Open Campus Seatline for the latest seat availability.',
        data: {
          event_type: 'bus_reported_at_stop',
          event_id: event.id,
          trip_id: trip.id,
          trip_direction: trip.direction,
          bus_id: bus.id,
          stop_id: stop.id
        }
      })
    }
    emitAdmins('arrival', {
      id: event.id, tripId: trip.id, tripDirection: trip.direction,
      busId: bus.id, busName: bus.name,
      stopId: stop.id, stopName: stop.name, timestamp: now, inferredStopIds
    })
  }

  return finish({
    ok: true,
    promoted,
    arrivalCreated,
    inferredStopIds,
    transferredFromBusId: transition.released?.busId || null
  })
}

export function promptsForUser(userId) {
  const db = getDb()
  const now = Date.now()
  return db.prompts
    .filter(prompt => {
      const trip = tripById(prompt.tripId)
      return prompt.userId === userId && trip?.status === 'active' &&
        prompt.status === 'pending' && new Date(prompt.expiresAt).getTime() > now
    })
    .map(p => ({
      id: p.id,
      userId: p.userId,
      tripId: p.tripId,
      tripDirection: p.tripDirection,
      busId: p.busId,
      stopId: p.stopId,
      kind: p.kind,
      detectionSource: p.detectionSource,
      status: p.status,
      tripDate: p.tripDate,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      ...(p.beacon ? {
        bleDiagnostic: {
          rssi: p.beacon.rssi,
          txPower: p.beacon.txPower
        }
      } : {}),
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

function recordEveningAlight(user, trip, bus, stopId) {
  const report = riderTripState(user.id, bus.id)
  if (!report || report.state !== 'seats_occupied' || report.alightStopId !== stopId) return null
  const now = new Date().toISOString()
  report.state = 'released'
  report.releaseReason = 'evening_alighted'
  report.releasedAt = now
  report.updatedAt = now
  touchTrip(trip)
  logAttempt({
    userId: user.id, trip, stopId, channel: 'ble_alight', requested: 'detected',
    outcome: 'accepted_alight', message: 'Evening alight decrement recorded without a reporting prompt'
  })
  feedback(user.id, `Alighting at ${stopById(stopId)?.name || 'your stop'} recorded. ${bus.name}'s occupied count was decremented.`)
  emitAll('bus-passed', {
    tripId: trip.id, tripDirection: trip.direction, busId: bus.id, stopId,
    timestamp: now, informationalOnly: true
  })
  broadcastAll()
  syncRiderState(user.id)
  return { kind: 'alight_recorded', alighted: true, tripId: trip.id, busId: bus.id, stopId }
}

export function handleDetection({ userId, busId, stopId, source = 'mock', beacon = null }) {
  const db = getDb()
  const user = userById(userId)
  const bus = busById(busId)
  const stop = stopById(stopId)
  const trip = activeTripForBus(busId)
  const context = riderContextForTrip(user, trip)
  if (!user || !bus || !stop || !trip || user.role !== 'rider' || !context.eligible ||
    !trip.stopSequence.includes(stop.id)) {
    throw new Error('Invalid detection payload: rider, active trip, bus and effective stop must match')
  }

  const existingReport = riderTripState(userId, busId)
  if (trip.direction === 'evening' && existingReport?.state === 'seats_occupied') {
    return recordEveningAlight(user, trip, bus, stop.id)
  }
  if (existingReport?.state === 'seats_occupied') {
    feedback(userId, `You've already been counted as boarded on ${bus.name} for this trip.`)
    return null
  }

  const otherActive = activeReportForUser(userId, trip)
  if (otherActive?.state === 'seats_occupied' && otherActive.busId !== busId) {
    const otherBus = busById(otherActive.busId)
    feedback(
      userId,
      `You've already been counted as boarded on ${otherBus?.name || 'another bus'} for this trip.`
    )
    return null
  }

  const now = Date.now()
  const reportingStopId = context.boardingStopId
  const existing = db.prompts.find(p =>
    p.userId === userId && p.tripId === trip.id && p.stopId === reportingStopId &&
    p.status === 'pending' && new Date(p.expiresAt).getTime() > now
  )
  if (existing) return existing

  const prompt = {
    id: nextId(), userId, tripId: trip.id, busId, stopId: reportingStopId, kind: 'ble_confirm',
    detectionSource: source,
    beacon: beacon ? {
      format: beacon.format,
      uuid: beacon.uuid,
      major: beacon.major,
      minor: beacon.minor,
      rssi: beacon.rssi,
      txPower: beacon.txPower
    } : null,
    status: 'pending', tripDate: trip.date, tripDirection: trip.direction,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PROMPT_TTL_MS).toISOString()
  }
  db.prompts.push(prompt)
  setTimeout(() => {
    void runDatabaseTransaction(() => expirePrompt(prompt.id)).catch(error => {
      console.error('Prompt expiry persistence failed:', error.message)
    })
  }, PROMPT_TTL_MS + 300)

  const reportingStop = stopById(reportingStopId)
  const n = pushNotification(userId, `Have you boarded ${bus.name} at ${reportingStop?.name || 'the boarding stop'}?`, 'prompt')
  emitToUser(userId, 'notification', n)
  emitToUser(userId, 'prompts', promptsForUser(userId))
  void sendPushToUser({
    userId,
    title: `${bus.name} at ${reportingStop?.name || 'your boarding stop'}`,
    body: 'Have you boarded? Tap Yes or No below.',
    data: {
      event_type: 'ble_confirmation_prompt',
      event_id: prompt.id,
      trip_id: trip.id,
      trip_direction: trip.direction,
      bus_id: bus.id,
      stop_id: reportingStopId,
      expires_at: prompt.expiresAt,
      expires_in_ms: Math.max(new Date(prompt.expiresAt).getTime() - Date.now(), 0)
    }
  }).catch(error => {
    console.error('BLE confirmation FCM delivery failed:', error.message)
  })
  return prompt
}

export function applyAvailableOverride(incharge, bus, seatsAvailable) {
  const db = getDb()
  const trip = activeTripForBus(bus.id)
  if (!trip) return { ok: false, status: 409, error: `No active trip for ${bus.name}` }
  const now = new Date().toISOString()

  const { baseOccupied, softHolds } = countsForTrip(trip)
  const maximumAvailable = bus.capacity - softHolds
  if (!Number.isInteger(seatsAvailable) || seatsAvailable < 0 || seatsAvailable > maximumAvailable) {
    return {
      ok: false,
      status: 400,
      error: `Seats Available must be an integer between 0 and ${maximumAvailable} while ${softHolds} Soft Hold${softHolds === 1 ? ' is' : 's are'} active`
    }
  }
  const occ = tripOccupancyOf(trip.id)
  const previousOccupied = clamp(baseOccupied + occ.manualAdjustment, 0, bus.capacity)
  const previousAvailable = clamp(bus.capacity - previousOccupied - softHolds, 0, bus.capacity)

  const targetOccupied = clamp(bus.capacity - seatsAvailable - softHolds, 0, bus.capacity)
  occ.manualAdjustment = targetOccupied - baseOccupied
  occ.lastUpdated = now

  const entry = {
    id: nextId(), inchargeId: incharge.id, tripId: trip.id, busId: bus.id,
    tripDate: trip.date, tripDirection: trip.direction,
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
