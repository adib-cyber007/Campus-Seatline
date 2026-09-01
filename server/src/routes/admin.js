import { Router } from 'express'
import {
  getDb, nextId, busById, stopById, sanitizeUser, activeBuses, activeStops, todayKey,
  busByIdIncludingArchived, stopByIdIncludingArchived, riderCountForStop, hashPassword
} from '../db.js'
import { authenticate, requireRole } from '../auth.js'
import { snapshot } from '../services/occupancy.js'
import { auditSnapshot } from '../services/audit.js'
import { answerAdminQuestion } from '../services/adminAssistant.js'
import { emitAll } from '../realtime.js'
import { beaconIdentityForBus } from '../beaconIdentity.js'
import { enrichedUnmetDemandEvents, aggregateUnmetDemand } from '../services/unmetDemand.js'

const router = Router()
router.use(authenticate, requireRole('admin'))

function syncStopBusLink(stopId, wantedBusIds) {
  const db = getDb()
  const stop = stopById(stopId)
  if (!stop) return
  const wantedIds = [...new Set(wantedBusIds)]
  for (const bus of activeBuses()) {
    const linked = bus.stopIds.includes(stopId)
    const wanted = wantedIds.includes(bus.id)
    if (wanted && !linked) {
      bus.stopIds.push(stopId)
    }
    if (!wanted && linked) {
      bus.stopIds = bus.stopIds.filter(s => s !== stopId)
    }
  }
  stop.busIds = activeBuses().filter(bus => bus.stopIds.includes(stopId)).map(bus => bus.id)
}

function syncBusStopLinks(bus) {
  const db = getDb()
  bus.stopIds = [...new Set(bus.stopIds)]
  for (const stop of activeStops()) {
    const linked = stop.busIds.includes(bus.id)
    const wanted = bus.stopIds.includes(stop.id)
    if (wanted && !linked) stop.busIds.push(bus.id)
    if (!wanted && linked) stop.busIds = stop.busIds.filter(b => b !== bus.id)
    stop.busIds = [...new Set(stop.busIds.filter(id => Boolean(busById(id))))]
  }
}

function enrichAssignment(a) {
  return {
    ...a,
    riderName: getDb().users.find(u => u.id === a.riderId)?.name || a.riderId,
    grantedByName: getDb().users.find(u => u.id === a.grantedByAdminId)?.name || a.grantedByAdminId,
    scopeName: a.scopeType === 'bus'
      ? (busByIdIncludingArchived(a.busId)?.name || a.busId)
      : (stopByIdIncludingArchived(a.stopId)?.name || a.stopId)
  }
}

function refreshClients(reason) {
  emitAll('refresh', { reason })
}

router.get('/overview', (req, res) => {
  const db = getDb()
  const stops = activeStops().map(stop => ({
    ...stop,
    busIds: stop.busIds.filter(id => Boolean(busById(id))),
    riderCount: riderCountForStop(stop.id)
  }))
  const unmetDemandEvents = enrichedUnmetDemandEvents()
  res.json({
    stops,
    buses: activeBuses().map(b => ({
      ...b,
      stopIds: b.stopIds.filter(id => Boolean(stopById(id))),
      occ: snapshot().find(s => s.busId === b.id),
      inchargeNames: db.inchargeAssignments
        .filter(a => !a.revokedAt && ((a.scopeType === 'bus' && a.busId === b.id) ||
          (a.scopeType === 'stop' && b.stopIds.includes(a.stopId) && Boolean(stopById(a.stopId)))))
        .map(a => db.users.find(u => u.id === a.riderId)?.name || a.riderId)
    })),
    users: db.users.filter(u => u.active !== false).map(u => ({
      ...sanitizeUser(u),
      stopNames: u.stopIds.map(id => stopByIdIncludingArchived(id)?.name || id)
    })),
    assignments: db.inchargeAssignments.map(enrichAssignment),
    occupancy: snapshot(),
    unmetDemand: {
      events: unmetDemandEvents,
      summary: aggregateUnmetDemand(unmetDemandEvents)
    },
    audit: auditSnapshot()
  })
})
router.post('/assistant/query', async (req, res) => {
  try {
    const result = await answerAdminQuestion(req.body?.question)
    res.json(result)
  } catch (error) {
    res.status(error.status || 502).json({
      error: error.status
        ? error.message
        : 'The Admin AI assistant is temporarily unavailable. No data was changed; please try again later.'
    })
  }
})

router.post('/users', (req, res) => {
  const db = getDb()
  const { name, email, password, role, stopIds } = req.body || {}
  const cleanName = String(name || '').trim()
  const cleanEmail = String(email || '').trim().toLowerCase()
  if (!cleanName || !cleanEmail || !password) {
    return res.status(400).json({ error: 'Name, email and initial password are required' })
  }
  if (String(password).length < 6) return res.status(400).json({ error: 'Initial password must be at least 6 characters' })
  if (!['rider', 'admin'].includes(role)) return res.status(400).json({ error: 'Role must be rider or admin' })
  if (db.users.some(user => user.email.toLowerCase() === cleanEmail)) {
    return res.status(409).json({ error: 'Email already exists, including archived accounts' })
  }
  const ids = role === 'rider' && Array.isArray(stopIds) ? [...new Set(stopIds)] : []
  if (role === 'rider' && ids.length === 0) return res.status(400).json({ error: 'Select at least one stop for a rider' })
  if (ids.some(id => !stopById(id))) return res.status(400).json({ error: 'Unknown stop in selection' })

  const user = {
    id: nextId(), name: cleanName, email: cleanEmail, role,
    passwordHash: hashPassword(String(password)), stopIds: ids, active: true,
    createdAt: new Date().toISOString()
  }
  db.users.push(user)
  refreshClients('user-created')
  res.status(201).json({
    user: { ...sanitizeUser(user), stopNames: ids.map(id => stopById(id)?.name || id) }
  })
})

router.delete('/users/:id', (req, res) => {
  const db = getDb()
  const user = db.users.find(item => item.id === req.params.id && item.active !== false)
  if (!user) return res.status(404).json({ error: 'Active user not found' })
  if (user.id === req.user.id) return res.status(409).json({ error: 'You cannot remove your own signed-in Admin account' })
  if (user.role === 'admin' && db.users.filter(item => item.active !== false && item.role === 'admin').length <= 1) {
    return res.status(409).json({ error: 'The last active Admin account cannot be removed' })
  }

  const activeReports = db.boardingReports.filter(report =>
    report.userId === user.id && report.tripDate === todayKey() &&
    ['soft_hold', 'seats_occupied'].includes(report.state)
  )
  if (activeReports.length > 0) {
    return res.status(409).json({
      error: `Cannot remove ${user.name}: ${activeReports.length} active trip report${activeReports.length === 1 ? '' : 's'} must be released or completed first.`,
      dependencies: { activeReports: activeReports.length }
    })
  }

  const now = new Date().toISOString()
  const revokedAssignmentIds = []
  for (const assignment of db.inchargeAssignments.filter(item => item.riderId === user.id && !item.revokedAt)) {
    assignment.revokedAt = now
    assignment.revokedByAdminId = req.user.id
    revokedAssignmentIds.push(assignment.id)
  }
  for (const prompt of db.prompts.filter(item => item.userId === user.id && item.status === 'pending')) {
    prompt.status = 'cancelled'
    prompt.answeredAt = now
  }
  for (const token of db.deviceTokens.filter(item => item.userId === user.id && item.active)) {
    token.active = false
    token.deactivatedAt = now
    token.deactivationReason = 'user_archived'
    token.updatedAt = now
  }
  user.active = false
  user.archivedAt = now
  user.archivedByAdminId = req.user.id
  refreshClients('user-archived')
  res.json({ archived: true, user: sanitizeUser(user), revokedAssignmentIds })
})

router.post('/incharge-assignments', (req, res) => {
  const db = getDb()
  const { riderId, scopeType, busId, stopId } = req.body || {}
  const rider = db.users.find(u => u.id === riderId && u.active !== false)
  if (!rider) return res.status(404).json({ error: 'Rider not found' })
  if (rider.role !== 'rider') return res.status(400).json({ error: 'Incharge authority can only be granted to rider accounts' })
  if (!['bus', 'stop'].includes(scopeType)) return res.status(400).json({ error: 'Scope must be bus or stop' })
  if (scopeType === 'bus') {
    if (!busId || !busById(busId)) return res.status(400).json({ error: 'Valid busId required for bus scope' })
  } else {
    if (!stopId || !stopById(stopId)) return res.status(400).json({ error: 'Valid stopId required for stop scope' })
  }

  const duplicate = db.inchargeAssignments.find(a =>
    !a.revokedAt && a.riderId === riderId && a.scopeType === scopeType &&
    (scopeType === 'bus' ? a.busId === busId : a.stopId === stopId)
  )
  if (duplicate) return res.status(409).json({ error: 'This rider already has that active Incharge authority' })

  const assignment = {
    id: nextId(),
    riderId,
    scopeType,
    busId: scopeType === 'bus' ? busId : null,
    stopId: scopeType === 'stop' ? stopId : null,
    grantedByAdminId: req.user.id,
    grantedAt: new Date().toISOString(),
    revokedAt: null
  }
  db.inchargeAssignments.push(assignment)
  refreshClients('assignment-granted')
  res.status(201).json({ assignment: enrichAssignment(assignment) })
})

router.delete('/incharge-assignments/:id', (req, res) => {
  const db = getDb()
  const assignment = db.inchargeAssignments.find(a => a.id === req.params.id)
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' })
  if (assignment.revokedAt) return res.status(409).json({ error: 'Assignment already revoked' })
  assignment.revokedAt = new Date().toISOString()
  assignment.revokedByAdminId = req.user.id
  refreshClients('assignment-revoked')
  res.json({ assignment: enrichAssignment(assignment) })
})

router.post('/stops', (req, res) => {
  const { name, timeline, busIds } = req.body || {}
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Stop name required' })
  const ids = Array.isArray(busIds) ? [...new Set(busIds)] : []
  if (ids.some(id => !busById(id))) return res.status(400).json({ error: 'Unknown bus in selection' })
  const rows = Array.isArray(timeline)
    ? timeline.filter(r => r && r.time).map(r => ({ time: String(r.time), label: String(r.label || '') }))
    : []
  const stop = { id: nextId(), name: String(name).trim(), timeline: rows, busIds: [], active: true }
  getDb().stops.push(stop)
  syncStopBusLink(stop.id, ids)
  refreshClients('stop-created')
  res.status(201).json({ stop })
})

router.put('/stops/:id', (req, res) => {
  const stop = stopById(req.params.id)
  if (!stop) return res.status(404).json({ error: 'Stop not found' })
  const { name, timeline, busIds } = req.body || {}
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'Stop name cannot be empty' })
    stop.name = String(name).trim()
  }
  if (timeline !== undefined) {
    if (!Array.isArray(timeline)) return res.status(400).json({ error: 'Timeline must be an array' })
    stop.timeline = timeline.filter(r => r && r.time).map(r => ({ time: String(r.time), label: String(r.label || '') }))
  }
  if (busIds !== undefined) {
    if (!Array.isArray(busIds)) return res.status(400).json({ error: 'busIds must be an array' })
    if (busIds.some(id => !busById(id))) return res.status(400).json({ error: 'Unknown bus in selection' })
    syncStopBusLink(stop.id, busIds)
  }
  refreshClients('stop-updated')
  res.json({ stop })
})

router.post('/buses', (req, res) => {
  const { name, capacity, stopIds } = req.body || {}
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Bus name required' })
  const cap = Number(capacity)
  if (!Number.isInteger(cap) || cap <= 0) return res.status(400).json({ error: 'Capacity must be a positive integer' })
  const ids = Array.isArray(stopIds) ? [...new Set(stopIds)] : []
  if (ids.some(id => !stopById(id))) return res.status(400).json({ error: 'Unknown stop in path' })

  const id = nextId()
  const bus = {
    id, name: String(name).trim(), capacity: cap, stopIds: ids, active: true,
    beacon: beaconIdentityForBus(id)
  }
  getDb().buses.push(bus)
  syncBusStopLinks(bus)
  refreshClients('bus-created')
  res.status(201).json({ bus })
})

router.put('/buses/:id', (req, res) => {
  const bus = busById(req.params.id)
  if (!bus) return res.status(404).json({ error: 'Bus not found' })
  const { name, capacity, stopIds } = req.body || {}
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'Bus name cannot be empty' })
    bus.name = String(name).trim()
  }
  if (capacity !== undefined) {
    const cap = Number(capacity)
    if (!Number.isInteger(cap) || cap <= 0) return res.status(400).json({ error: 'Capacity must be a positive integer' })
    const current = snapshot().find(item => item.busId === bus.id)
    const committedSeats = (current?.seatsOccupied || 0) + (current?.softHolds || 0)
    if (cap < committedSeats) {
      return res.status(409).json({
        error: `Capacity cannot be lower than the ${committedSeats} currently occupied or held seats`
      })
    }
    bus.capacity = cap
  }
  if (stopIds !== undefined) {
    if (!Array.isArray(stopIds)) return res.status(400).json({ error: 'stopIds must be an array' })
    const ids = [...new Set(stopIds)]
    if (ids.some(id => !stopById(id))) return res.status(400).json({ error: 'Unknown stop in path' })
    bus.stopIds = ids
    syncBusStopLinks(bus)
  }
  refreshClients('bus-updated')
  res.json({ bus })
})

function busArchiveDependencies(bus) {
  const db = getDb()
  const current = snapshot().find(item => item.busId === bus.id)
  return {
    activeRiders: (current?.softHolds || 0) + (current?.seatsOccupied || 0),
    pendingPrompts: db.prompts.filter(item => item.busId === bus.id && item.status === 'pending').length,
    activeAssignments: db.inchargeAssignments.filter(item =>
      !item.revokedAt && item.scopeType === 'bus' && item.busId === bus.id
    ).length
  }
}

function stopArchiveDependencies(stop) {
  const db = getDb()
  const tripDate = todayKey()
  return {
    registeredRiders: db.users.filter(user =>
      user.active !== false && user.role === 'rider' && user.stopIds.includes(stop.id)
    ).length,
    activeReports: db.boardingReports.filter(item =>
      item.stopId === stop.id && item.tripDate === tripDate && ['soft_hold', 'seats_occupied'].includes(item.state)
    ).length,
    pendingPrompts: db.prompts.filter(item => item.stopId === stop.id && item.status === 'pending').length,
    dailyOverrides: db.dailyStopOverrides.filter(item => item.stopId === stop.id && item.tripDate === tripDate).length,
    activeAssignments: db.inchargeAssignments.filter(item =>
      !item.revokedAt && item.scopeType === 'stop' && item.stopId === stop.id
    ).length
  }
}

function dependencyTotal(dependencies) {
  return Object.values(dependencies).reduce((sum, value) => sum + value, 0)
}

router.delete('/buses/:id', (req, res) => {
  const bus = busById(req.params.id)
  if (!bus) return res.status(404).json({ error: 'Active bus not found' })
  const dependencies = busArchiveDependencies(bus)
  if (dependencyTotal(dependencies) > 0) {
    return res.status(409).json({
      error: `Cannot remove ${bus.name}: ${dependencies.activeRiders} active riders/seats, ${dependencies.pendingPrompts} pending prompts, and ${dependencies.activeAssignments} active Incharge assignments must be resolved first.`,
      dependencies
    })
  }
  bus.active = false
  bus.archivedAt = new Date().toISOString()
  bus.archivedByAdminId = req.user.id
  bus.beacon = { ...bus.beacon, active: false }
  refreshClients('bus-archived')
  res.json({ archived: true, bus })
})

router.delete('/stops/:id', (req, res) => {
  const stop = stopById(req.params.id)
  if (!stop) return res.status(404).json({ error: 'Active stop not found' })
  const dependencies = stopArchiveDependencies(stop)
  if (dependencyTotal(dependencies) > 0) {
    return res.status(409).json({
      error: `Cannot remove ${stop.name}: ${dependencies.registeredRiders} registered riders, ${dependencies.activeReports} active reports, ${dependencies.pendingPrompts} pending prompts, ${dependencies.dailyOverrides} daily overrides, and ${dependencies.activeAssignments} active Incharge assignments must be resolved first.`,
      dependencies
    })
  }
  stop.active = false
  stop.archivedAt = new Date().toISOString()
  stop.archivedByAdminId = req.user.id
  refreshClients('stop-archived')
  res.json({ archived: true, stop })
})

export default router
