import crypto from 'node:crypto'

const uid = () => crypto.randomUUID()

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':')
  if (!salt || !hash) return false
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex')
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'))
}

const db = {
  users: [],
  stops: [],
  buses: [],
  occupancy: {},
  boardingReports: [],
  reportAttempts: [],
  inchargeAssignments: [],
  arrivalEvents: [],
  prompts: [],
  notifications: [],
  overrides: [],
  dailyStopOverrides: [],
  autoHoldEvaluations: [],
  unmetDemandEvents: [],
  unmetDemandIndexes: {
    byStop: new Map(),
    byBus: new Map()
  }
}

export const nextId = uid
export const getDb = () => db

export function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function occupancyOf(busId) {
  const tripDate = todayKey()
  if (!db.occupancy[busId]) {
    db.occupancy[busId] = { busId, manualAdjustment: 0, lastUpdated: new Date().toISOString(), tripDate }
  } else if (db.occupancy[busId].tripDate !== tripDate) {
    db.occupancy[busId] = {
      busId,
      manualAdjustment: 0,
      lastUpdated: new Date().toISOString(),
      tripDate
    }
  }
  return db.occupancy[busId]
}

export function pushNotification(userId, message, type = 'info') {
  const n = { id: uid(), userId, message, type, createdAt: new Date().toISOString() }
  db.notifications.push(n)
  return n
}

export function sanitizeUser(u) {
  if (!u) return null
  const { passwordHash, ...rest } = u
  return rest
}

export const userById = id => db.users.find(u => u.id === id)
export const busById = id => db.buses.find(b => b.id === id)
export const stopById = id => db.stops.find(s => s.id === id)
export const busesForStops = stopIds =>
  db.buses.filter(b => b.stopIds.some(s => stopIds.includes(s)))

function addToIndex(index, key, event) {
  const items = index.get(key) || []
  items.push(event)
  index.set(key, items)
}

export function createUnmetDemandEvent({ riderId, stopId, busId, availableSeatsAtTime }) {
  if (!userById(riderId) || !stopById(stopId) || !busById(busId)) {
    throw new Error('Unmet demand requires a valid rider, stop and bus')
  }
  const now = new Date().toISOString()
  const event = {
    id: uid(),
    riderId,
    stopId,
    busId,
    timestamp: now,
    availableSeatsAtTime: Number(availableSeatsAtTime),
    createdAt: now
  }
  db.unmetDemandEvents.push(event)
  addToIndex(db.unmetDemandIndexes.byStop, stopId, event)
  addToIndex(db.unmetDemandIndexes.byBus, busId, event)
  return event
}

export function queryUnmetDemandEvents({ since, stopId, busId } = {}) {
  let events = db.unmetDemandEvents
  if (stopId) events = db.unmetDemandIndexes.byStop.get(stopId) || []
  if (busId) {
    const busEvents = db.unmetDemandIndexes.byBus.get(busId) || []
    events = stopId ? events.filter(event => event.busId === busId) : busEvents
  }
  const sinceMs = since ? new Date(since).getTime() : null
  return events
    .filter(event => sinceMs === null || new Date(event.timestamp).getTime() >= sinceMs)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
}

const ACTIVE_REPORT_STATES = new Set(['soft_hold', 'seats_occupied'])

export function activeReportForUser(userId, tripDate = todayKey()) {
  const active = db.boardingReports.filter(
    report => report.userId === userId && report.tripDate === tripDate && ACTIVE_REPORT_STATES.has(report.state)
  )
  if (active.length > 1) {
    throw new Error(`Rider report invariant violated for ${userId} on ${tripDate}`)
  }
  return active[0] || null
}

function reportFor(userId, busId, tripDate) {
  return db.boardingReports.find(
    report => report.userId === userId && report.busId === busId && report.tripDate === tripDate
  )
}

/**
 * The single write boundary for today's rider report state. It runs synchronously,
 * validates first, then releases any previous Soft Hold and applies the target state
 * before returning, so no observer can see a half-completed bus switch.
 */
export function transitionRiderReport({ userId, busId, stopId = null, toState, source = 'manual' }) {
  if (!ACTIVE_REPORT_STATES.has(toState)) throw new Error(`Unsupported rider report state: ${toState}`)

  const tripDate = todayKey()
  const active = activeReportForUser(userId, tripDate)
  if (active?.state === 'seats_occupied') {
    return {
      ok: false,
      reason: active.busId === busId ? 'already_occupied_same_bus' : 'already_occupied_other_bus',
      active
    }
  }
  if (active?.busId === busId && active.state === toState) {
    return { ok: true, changed: false, record: active, previous: active, released: null }
  }

  const now = new Date().toISOString()
  let target = reportFor(userId, busId, tripDate)
  if (!target) {
    target = {
      id: uid(), userId, busId, stopId, tripDate, state: null, source,
      createdAt: now, updatedAt: now
    }
    db.boardingReports.push(target)
  }

  const previous = active ? { ...active } : null
  let released = null
  if (active && active.busId !== busId) {
    released = { ...active }
    active.state = 'released'
    active.releasedAt = now
    active.releaseReason = toState === 'seats_occupied' ? 'ble_bus_switch' : 'soft_hold_transfer'
    active.updatedAt = now
  }

  const promoted = active?.busId === busId && active.state === 'soft_hold' && toState === 'seats_occupied'
  target.state = toState
  target.stopId = stopId
  target.source = source
  target.updatedAt = now
  delete target.releasedAt
  delete target.releaseReason

  // Re-read through the invariant guard before exposing the result.
  activeReportForUser(userId, tripDate)
  return { ok: true, changed: true, record: target, previous, released, promoted }
}

export function releaseRiderSoftHold({ userId, busId, reason = 'rider_release' }) {
  const active = activeReportForUser(userId)
  if (!active || active.state !== 'soft_hold' || active.busId !== busId) {
    return { ok: false, reason: 'no_active_soft_hold', active }
  }
  const now = new Date().toISOString()
  active.state = 'released'
  active.releasedAt = now
  active.releaseReason = reason
  active.updatedAt = now
  activeReportForUser(userId)
  return { ok: true, changed: true, record: active }
}

export function dailyStopOverrideForUser(userId, tripDate = todayKey()) {
  return db.dailyStopOverrides.find(item => item.userId === userId && item.tripDate === tripDate) || null
}

export function effectiveStopIdsForUser(user, tripDate = todayKey()) {
  const override = dailyStopOverrideForUser(user.id, tripDate)
  return override ? [override.stopId] : user.stopIds
}

export function setDailyStopOverride(userId, stopId) {
  const tripDate = todayKey()
  let item = dailyStopOverrideForUser(userId, tripDate)
  const now = new Date().toISOString()
  if (!item) {
    item = { id: uid(), userId, stopId, tripDate, createdAt: now, updatedAt: now }
    db.dailyStopOverrides.push(item)
  } else {
    item.stopId = stopId
    item.updatedAt = now
  }
  return item
}

export function clearDailyStopOverride(userId) {
  const item = dailyStopOverrideForUser(userId)
  if (!item) return null
  const index = db.dailyStopOverrides.indexOf(item)
  db.dailyStopOverrides.splice(index, 1)
  return item
}

export function activeAssignments() {
  return db.inchargeAssignments.filter(a => !a.revokedAt)
}

export function riderAuthorityBusIds(userId) {
  return db.buses
    .filter(b =>
      activeAssignments().some(a =>
        a.riderId === userId &&
        ((a.scopeType === 'bus' && a.busId === b.id) ||
          (a.scopeType === 'stop' && b.stopIds.includes(a.stopId)))
      )
    )
    .map(b => b.id)
}

function seed() {
  const s1 = uid(), s2 = uid(), s3 = uid(), s4 = uid(), s5 = uid()
  const s6 = uid(), s7 = uid(), s8 = uid(), s9 = uid(), s10 = uid(), s11 = uid()
  const b1 = uid(), b2 = uid()

  db.stops.push(
    { id: s1, name: 'Main Gate', timeline: [{ time: '07:30', label: 'Morning' }], busIds: [b1, b2] },
    { id: s2, name: 'Library Block', timeline: [{ time: '07:45', label: 'Morning' }], busIds: [b1] },
    { id: s3, name: 'Hostel Circle', timeline: [{ time: '08:00', label: 'Morning' }], busIds: [b1] },
    { id: s4, name: 'Sports Complex', timeline: [{ time: '07:50', label: 'Morning' }], busIds: [b2] },
    { id: s5, name: 'North Campus', timeline: [{ time: '08:10', label: 'Morning' }], busIds: [b2] },
    { id: s6, name: 'Annex Road', timeline: [], busIds: [] },
    { id: s7, name: 'City Center', timeline: [], busIds: [] },
    { id: s8, name: 'East Colony', timeline: [], busIds: [] },
    { id: s9, name: 'Old Hospital Junction', timeline: [], busIds: [] },
    { id: s10, name: 'River Side', timeline: [], busIds: [] },
    { id: s11, name: 'Tech Park', timeline: [], busIds: [] }
  )

  const admin = {
    id: uid(), name: 'Admin', email: 'admin@campus.edu',
    passwordHash: hashPassword('admin123'), role: 'admin', stopIds: []
  }
  const inch1 = {
    id: uid(), name: 'Incharge One', email: 'incharge@campus.edu',
    passwordHash: hashPassword('incharge123'), role: 'rider', stopIds: [s1]
  }
  const r1 = {
    id: uid(), name: 'Rider One', email: 'rider@campus.edu',
    passwordHash: hashPassword('rider123'), role: 'rider', stopIds: [s1]
  }
  const r2 = {
    id: uid(), name: 'Rider Two', email: 'rider2@campus.edu',
    passwordHash: hashPassword('rider123'), role: 'rider', stopIds: [s2]
  }
  const r3 = {
    id: uid(), name: 'Rider Three', email: 'rider3@campus.edu',
    passwordHash: hashPassword('rider123'), role: 'rider', stopIds: [s3]
  }
  db.users.push(admin, inch1, r1, r2, r3)

  db.buses.push(
    { id: b1, name: 'Shuttle-01', capacity: 40, stopIds: [s1, s2, s3] },
    { id: b2, name: 'Express-02', capacity: 24, stopIds: [s1, s4, s5] }
  )

  db.inchargeAssignments.push({
    id: uid(),
    riderId: inch1.id,
    scopeType: 'bus',
    busId: b1,
    stopId: null,
    grantedByAdminId: admin.id,
    grantedAt: new Date().toISOString(),
    revokedAt: null
  })
}

seed()
