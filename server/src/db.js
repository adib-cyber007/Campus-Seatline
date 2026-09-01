import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { applySchema, closeDatabase, withTransaction } from './database/client.js'
import { emptyState, loadState, saveState } from './database/stateStore.js'
import { beaconIdentityForBus } from './beaconIdentity.js'

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

const stateStorage = new AsyncLocalStorage()
let committedState = emptyState()
const currentState = () => {
  const context = stateStorage.getStore()
  return context?.open ? context.state : committedState
}
const db = new Proxy({}, {
  get(_target, property) { return currentState()[property] },
  set(_target, property, value) { currentState()[property] = value; return true },
  ownKeys() { return Reflect.ownKeys(currentState()) },
  getOwnPropertyDescriptor() { return { enumerable: true, configurable: true } }
})

export const nextId = uid
export const getDb = () => currentState()

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
export const busByIdIncludingArchived = id => db.buses.find(b => b.id === id)
export const stopByIdIncludingArchived = id => db.stops.find(s => s.id === id)
export const busById = id => db.buses.find(b => b.id === id && b.active !== false)
export const stopById = id => db.stops.find(s => s.id === id && s.active !== false)
export const activeBuses = () => db.buses.filter(b => b.active !== false)
export const activeStops = () => db.stops.filter(s => s.active !== false)
export function riderCountForStop(stopId) {
  const riderIds = new Set(
    db.users
      .filter(user => user.active !== false && user.role === 'rider' && user.stopIds.includes(stopId))
      .map(user => user.id)
  )
  for (const assignment of db.inchargeAssignments) {
    if (!assignment.revokedAt && assignment.scopeType === 'stop' && assignment.stopId === stopId) {
      riderIds.add(assignment.riderId)
    }
  }
  return riderIds.size
}
export const busesForStops = stopIds => {
  const activeStopIds = stopIds.filter(id => stopById(id))
  return activeBuses().filter(b => b.stopIds.some(s => activeStopIds.includes(s)))
}

export function activeDeviceTokensForUser(userId) {
  return db.deviceTokens.filter(token => token.userId === userId && token.active)
}

export function upsertDeviceToken({ userId, fcmToken, previousToken = null, platform = 'android' }) {
  const now = new Date().toISOString()

  // A physical Firebase token must never remain active for two rider accounts.
  for (const token of db.deviceTokens) {
    if (token.fcmToken === fcmToken && token.userId !== userId && token.active) {
      token.active = false
      token.deactivatedAt = now
      token.deactivationReason = 'registered_to_another_rider'
      token.updatedAt = now
    }
  }

  let record = db.deviceTokens.find(token => token.userId === userId && token.fcmToken === fcmToken)
  if (previousToken && previousToken !== fcmToken) {
    const previousRecord = db.deviceTokens.find(token => token.userId === userId && token.fcmToken === previousToken)
    if (!record && previousRecord) {
      record = previousRecord
      record.fcmToken = fcmToken
    } else if (record && previousRecord && previousRecord !== record && previousRecord.active) {
      previousRecord.active = false
      previousRecord.deactivatedAt = now
      previousRecord.deactivationReason = 'fcm_token_rotated'
      previousRecord.updatedAt = now
    }
  }

  if (!record) {
    record = {
      id: uid(), userId, fcmToken, platform,
      active: true, createdAt: now, updatedAt: now, lastSeenAt: now
    }
    db.deviceTokens.push(record)
  } else {
    record.platform = platform
    record.active = true
    record.lastSeenAt = now
    record.updatedAt = now
    delete record.deactivatedAt
    delete record.deactivationReason
  }
  return record
}

export function deactivateDeviceToken({ userId, fcmToken, reason = 'logout' }) {
  const record = db.deviceTokens.find(token =>
    token.userId === userId && token.fcmToken === fcmToken && token.active
  )
  if (!record) return null
  const now = new Date().toISOString()
  record.active = false
  record.deactivatedAt = now
  record.deactivationReason = reason
  record.updatedAt = now
  return record
}

export function deactivateDeviceTokenValue(fcmToken, reason = 'invalid_fcm_token') {
  const now = new Date().toISOString()
  const records = db.deviceTokens.filter(token => token.fcmToken === fcmToken && token.active)
  for (const record of records) {
    record.active = false
    record.deactivatedAt = now
    record.deactivationReason = reason
    record.updatedAt = now
  }
  return records
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
  return db.inchargeAssignments.filter(a =>
    !a.revokedAt && (a.scopeType === 'bus' ? Boolean(busById(a.busId)) : Boolean(stopById(a.stopId)))
  )
}

export function riderAuthorityBusIds(userId) {
  return activeBuses()
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
    { id: b1, name: 'Shuttle-01', capacity: 40, stopIds: [s1, s2, s3], beacon: beaconIdentityForBus(b1) },
    { id: b2, name: 'Express-02', capacity: 24, stopIds: [s1, s4, s5], beacon: beaconIdentityForBus(b2) }
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

const DATABASE_LOCK_ID = 736328451

export function hasDatabaseContext() {
  return Boolean(stateStorage.getStore()?.open)
}

export async function runDatabaseTransaction(work, { persist = true } = {}) {
  const existing = stateStorage.getStore()
  if (existing?.open) return work(existing.state)

  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [DATABASE_LOCK_ID])
    const state = await loadState(client)
    const context = { state, client, open: true }
    try {
      const result = await stateStorage.run(context, () => work(state))
      if (persist) await saveState(client, state)
      committedState = structuredClone(state)
      return result
    } finally {
      context.open = false
    }
  }, { isolation: 'READ COMMITTED', retries: 0 })
}

export async function resetDatabase({ withSeed = true } = {}) {
  if (process.env.SEATLINE_TEST_SCHEMA !== 'seatline_test') {
    throw new Error('Refusing to reset a non-test database')
  }
  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [DATABASE_LOCK_ID])
    const state = emptyState()
    const context = { state, client, open: true }
    try {
      if (withSeed) await stateStorage.run(context, async () => seed())
      await saveState(client, state)
      committedState = structuredClone(state)
    } finally {
      context.open = false
    }
  }, { isolation: 'READ COMMITTED', retries: 0 })
}

export function databaseMiddleware(req, res, next) {
  const originals = {
    json: res.json.bind(res),
    send: res.send.bind(res),
    end: res.end.bind(res)
  }
  let captured = false
  let resolveResponse
  const response = new Promise(resolve => { resolveResponse = resolve })
  const capture = type => (...args) => {
    if (!captured) {
      captured = true
      resolveResponse({ type, args })
    }
    return res
  }
  res.json = capture('json')
  res.send = capture('send')
  res.end = capture('end')

  runDatabaseTransaction(async () => {
    next()
    return response
  }).then(pending => {
    res.json = originals.json
    res.send = originals.send
    res.end = originals.end
    originals[pending.type](...pending.args)
  }).catch(error => {
    res.json = originals.json
    res.send = originals.send
    res.end = originals.end
    next(error)
  })
}

export { closeDatabase }

await applySchema()
await runDatabaseTransaction(async state => {
  if (state.users.length === 0) seed()
})
