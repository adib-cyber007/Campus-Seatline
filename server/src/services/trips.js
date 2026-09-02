import { activeBuses, effectiveStopIdsForUser, getDb, nextId, runDatabaseTransaction } from '../db.js'
import { emitAdmins, emitAll } from '../realtime.js'

const ACTIVE_REPORT_STATES = new Set(['soft_hold', 'seats_occupied'])
const DIRECTIONS = ['morning', 'evening']
const DEFAULT_SCHEDULER_INTERVAL_MS = 30_000
const activationHandlers = new Set()
let scheduler = null

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function dateKeyAt(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function localDateForKey(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number)
  return new Date(year, month - 1, day, 12, 0, 0, 0)
}

function minutesAt(value) {
  const date = value instanceof Date ? value : new Date(value)
  return date.getHours() * 60 + date.getMinutes()
}

function minutesForTime(value, fallback) {
  const [hours, minutes] = String(value || fallback).split(':').map(Number)
  return hours * 60 + minutes
}

export function isServiceDate(dateKey, calendar = getDb().operatingCalendar) {
  const exception = calendar.exceptions.find(item => item.date === dateKey)
  if (exception) return Boolean(exception.service)
  const day = localDateForKey(dateKey).getDay() || 7
  return calendar.serviceWeekdays.includes(day)
}

export function tripById(tripId) {
  return getDb().trips.find(trip => trip.id === tripId) || null
}

export function activeTripForBus(busId) {
  const active = getDb().trips.filter(trip => trip.busId === busId && trip.status === 'active')
  if (active.length > 1) throw new Error(`Trip invariant violated: bus ${busId} has more than one active trip`)
  return active[0] || null
}

export function activeTripsForService(date, direction) {
  return getDb().trips.filter(trip =>
    trip.date === date && trip.direction === direction && trip.status === 'active'
  )
}

export function currentServicePeriod() {
  const active = getDb().trips.filter(trip => trip.status === 'active')
    .sort((a, b) => String(b.activatedAt).localeCompare(String(a.activatedAt)))
  if (!active.length) return null
  return { date: active[0].date, direction: active[0].direction }
}

export function tripOccupancyOf(tripId) {
  const db = getDb()
  if (!db.tripOccupancy[tripId]) {
    db.tripOccupancy[tripId] = {
      tripId,
      manualAdjustment: 0,
      lastUpdated: new Date().toISOString()
    }
  }
  return db.tripOccupancy[tripId]
}

export function countsForTrip(trip) {
  const bus = getDb().buses.find(item => item.id === trip.busId)
  if (!bus) return { baseOccupied: 0, softHolds: 0, manualAdjustment: 0, seatsOccupied: 0, availableSeats: 0 }
  const records = getDb().boardingReports.filter(report => report.tripId === trip.id)
  const baseOccupied = records.filter(report => report.state === 'seats_occupied').length
  const softHolds = records.filter(report => report.state === 'soft_hold').length
  const manualAdjustment = tripOccupancyOf(trip.id).manualAdjustment
  const seatsOccupied = clamp(baseOccupied + manualAdjustment, 0, bus.capacity)
  return {
    baseOccupied,
    softHolds,
    manualAdjustment,
    seatsOccupied,
    availableSeats: clamp(bus.capacity - seatsOccupied - softHolds, 0, bus.capacity)
  }
}

export function generateTripsForDate(dateKey) {
  const db = getDb()
  if (!isServiceDate(dateKey)) return []
  const created = []
  const now = new Date().toISOString()
  for (const bus of activeBuses()) {
    const morningStops = [...bus.stopIds]
    const definitions = [
      { direction: 'morning', stopSequence: morningStops, boardingStopSet: morningStops },
      {
        direction: 'evening',
        stopSequence: [...morningStops].reverse(),
        // The terminal of the configured morning path is the campus/College stop.
        boardingStopSet: morningStops.length ? [morningStops[morningStops.length - 1]] : []
      }
    ]
    for (const definition of definitions) {
      if (db.trips.some(trip =>
        trip.busId === bus.id && trip.date === dateKey && trip.direction === definition.direction
      )) continue
      const trip = {
        id: nextId(),
        busId: bus.id,
        date: dateKey,
        direction: definition.direction,
        stopSequence: definition.stopSequence,
        boardingStopSet: definition.boardingStopSet,
        status: 'scheduled',
        activatedAt: null,
        completedAt: null,
        completionReason: null,
        createdAt: now,
        updatedAt: now
      }
      db.trips.push(trip)
      created.push(trip)
    }
  }
  return created
}

function viableAlternatesForHold(report, trip) {
  const user = getDb().users.find(item => item.id === report.userId)
  if (!user) return []
  const effectiveStops = effectiveStopIdsForUser(user, trip.date)
  return activeTripsForService(trip.date, trip.direction)
    .filter(candidate => candidate.id !== trip.id &&
      candidate.stopSequence.some(stopId => effectiveStops.includes(stopId)) &&
      countsForTrip(candidate).availableSeats > 0)
    .map(candidate => candidate.busId)
}

export function forceCloseTrip(trip, { reason = 'force_closed', timestamp = new Date().toISOString() } = {}) {
  if (!trip || trip.status !== 'active') return null
  const db = getDb()
  const counts = countsForTrip(trip)
  const activeRecords = db.boardingReports.filter(report =>
    report.tripId === trip.id && ACTIVE_REPORT_STATES.has(report.state)
  )
  const unresolvedHolds = activeRecords.filter(report =>
    report.state === 'soft_hold' && trip.boardingStopSet.includes(report.stopId)
  )

  for (const report of unresolvedHolds) {
    const exists = db.unmetDemandEvents.some(event =>
      event.userId === report.userId && event.tripId === trip.id &&
      event.stopId === report.stopId && event.channel === 'force_close_unresolved_hold'
    )
    if (exists) continue
    const alternateBusIds = viableAlternatesForHold(report, trip)
    db.unmetDemandEvents.push({
      id: nextId(),
      userId: report.userId,
      tripId: trip.id,
      stopId: report.stopId,
      busId: trip.busId,
      channel: 'force_close_unresolved_hold',
      tripDate: trip.date,
      tripDirection: trip.direction,
      hadAlternateBus: alternateBusIds.length > 0,
      alternateBusIds,
      timestamp
    })
  }

  for (const report of activeRecords) {
    report.state = 'released'
    report.releaseReason = reason
    report.releasedAt = timestamp
    report.updatedAt = timestamp
  }
  for (const prompt of db.prompts.filter(item => item.tripId === trip.id && item.status === 'pending')) {
    prompt.status = 'cancelled'
    prompt.answeredAt = timestamp
  }

  const closure = {
    id: nextId(),
    tripId: trip.id,
    reason,
    finalBaseOccupied: counts.baseOccupied,
    finalManualAdjustment: counts.manualAdjustment,
    finalSeatsOccupied: counts.seatsOccupied,
    finalSoftHolds: counts.softHolds,
    unresolvedSoftHolds: unresolvedHolds.length,
    timestamp
  }
  db.tripClosures.push(closure)
  tripOccupancyOf(trip.id).manualAdjustment = 0
  tripOccupancyOf(trip.id).lastUpdated = timestamp
  trip.status = 'completed'
  trip.completedAt = timestamp
  trip.completionReason = reason
  trip.updatedAt = timestamp
  return closure
}

function desiredDirection(bus, now) {
  const currentMinutes = minutesAt(now)
  const morning = minutesForTime(bus.morningStartTime, '07:00')
  const evening = minutesForTime(bus.eveningStartTime, '17:00')
  if (currentMinutes >= evening) return 'evening'
  if (currentMinutes >= morning) return 'morning'
  return null
}

export function onTripActivated(handler) {
  activationHandlers.add(handler)
  return () => activationHandlers.delete(handler)
}

export function reconcileTripSchedule(now = new Date()) {
  const db = getDb()
  const date = dateKeyAt(now)
  const generated = generateTripsForDate(date)
  const activated = []
  const closed = []

  if (isServiceDate(date)) {
    for (const bus of activeBuses()) {
      const direction = desiredDirection(bus, now)
      if (!direction) continue
      const target = db.trips.find(trip =>
        trip.busId === bus.id && trip.date === date && trip.direction === direction
      )
      if (!target || target.status === 'completed') continue
      const current = activeTripForBus(bus.id)
      if (current && current.id !== target.id) {
        const closure = forceCloseTrip(current, { timestamp: now.toISOString() })
        if (closure) closed.push(closure)
      }
      if (target.status !== 'active') {
        // The advisory-lock transaction surrounding reconciliation makes close + activate atomic.
        target.status = 'active'
        target.activatedAt = now.toISOString()
        target.updatedAt = now.toISOString()
        tripOccupancyOf(target.id).manualAdjustment = 0
        tripOccupancyOf(target.id).lastUpdated = now.toISOString()
        activated.push(target)
        for (const handler of activationHandlers) handler(target)
      }
      activeTripForBus(bus.id)
    }
  }

  if (generated.length || activated.length || closed.length) {
    emitAll('refresh', { reason: 'trip-schedule-changed', date })
    emitAdmins('refresh', { reason: 'trip-schedule-changed', date })
  }
  return { date, serviceDay: isServiceDate(date), generated, activated, closed }
}

export function reconcileTripScheduleMiddleware(_req, _res, next) {
  try {
    reconcileTripSchedule()
    next()
  } catch (error) {
    next(error)
  }
}

export function startTripScheduler({ intervalMs = DEFAULT_SCHEDULER_INTERVAL_MS } = {}) {
  if (scheduler) return scheduler
  const tick = () => {
    void runDatabaseTransaction(() => reconcileTripSchedule()).catch(error => {
      console.error('Trip schedule reconciliation failed:', error.message)
    })
  }
  tick()
  scheduler = setInterval(tick, intervalMs)
  scheduler.unref?.()
  return scheduler
}

export function stopTripScheduler() {
  if (!scheduler) return
  clearInterval(scheduler)
  scheduler = null
}

export function validateTripDirection(value) {
  return DIRECTIONS.includes(value)
}
