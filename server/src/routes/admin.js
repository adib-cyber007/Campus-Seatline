import { Router } from 'express'
import { getDb, nextId, busById, stopById, sanitizeUser, queryUnmetDemandEvents } from '../db.js'
import { authenticate, requireRole } from '../auth.js'
import { snapshot, unmetDemandDisplay } from '../services/occupancy.js'
import { auditSnapshot } from '../services/audit.js'
import { answerAdminQuestion } from '../services/adminAssistant.js'
import { emitAll } from '../realtime.js'

const router = Router()
router.use(authenticate, requireRole('admin'))

function syncStopBusLink(stopId, wantedBusIds) {
  const db = getDb()
  const stop = stopById(stopId)
  if (!stop) return
  const wantedIds = [...new Set(wantedBusIds)]
  for (const bus of db.buses) {
    const linked = bus.stopIds.includes(stopId)
    const wanted = wantedIds.includes(bus.id)
    if (wanted && !linked) {
      bus.stopIds.push(stopId)
    }
    if (!wanted && linked) {
      bus.stopIds = bus.stopIds.filter(s => s !== stopId)
    }
  }
  stop.busIds = db.buses.filter(bus => bus.stopIds.includes(stopId)).map(bus => bus.id)
}

function syncBusStopLinks(bus) {
  const db = getDb()
  bus.stopIds = [...new Set(bus.stopIds)]
  for (const stop of db.stops) {
    const linked = stop.busIds.includes(bus.id)
    const wanted = bus.stopIds.includes(stop.id)
    if (wanted && !linked) stop.busIds.push(bus.id)
    if (!wanted && linked) stop.busIds = stop.busIds.filter(b => b !== bus.id)
    stop.busIds = [...new Set(stop.busIds.filter(id => db.buses.some(candidate => candidate.id === id)))]
  }
}

function enrichAssignment(a) {
  return {
    ...a,
    riderName: getDb().users.find(u => u.id === a.riderId)?.name || a.riderId,
    grantedByName: getDb().users.find(u => u.id === a.grantedByAdminId)?.name || a.grantedByAdminId,
    scopeName: a.scopeType === 'bus'
      ? (busById(a.busId)?.name || a.busId)
      : (stopById(a.stopId)?.name || a.stopId)
  }
}

function refreshClients(reason) {
  emitAll('refresh', { reason })
}

router.get('/unmet-demand', (req, res) => {
  const { since, stopId, busId } = req.query
  if (since && Number.isNaN(new Date(since).getTime())) {
    return res.status(400).json({ error: 'since must be a valid date-time' })
  }
  const requestedLimit = Number(req.query.limit ?? 100)
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 200) {
    return res.status(400).json({ error: 'limit must be an integer between 1 and 200' })
  }

  const allEvents = queryUnmetDemandEvents()
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const recentStart = now.getTime() - 30 * 60 * 1000
  const events = queryUnmetDemandEvents({ since, stopId, busId })
    .slice(0, requestedLimit)
    .map(unmetDemandDisplay)

  res.json({
    events,
    counts: {
      today: allEvents.filter(event => new Date(event.timestamp).getTime() >= todayStart).length,
      last30Minutes: allEvents.filter(event => new Date(event.timestamp).getTime() >= recentStart).length
    },
    windowMinutes: 30
  })
})

router.get('/overview', (req, res) => {
  const db = getDb()
  res.json({
    stops: db.stops,
    buses: db.buses.map(b => ({
      ...b,
      occ: snapshot().find(s => s.busId === b.id),
      inchargeNames: db.inchargeAssignments
        .filter(a => !a.revokedAt && ((a.scopeType === 'bus' && a.busId === b.id) ||
          (a.scopeType === 'stop' && b.stopIds.includes(a.stopId))))
        .map(a => db.users.find(u => u.id === a.riderId)?.name || a.riderId)
    })),
    users: db.users.map(u => ({
      ...sanitizeUser(u),
      stopNames: u.stopIds.map(id => stopById(id)?.name || id)
    })),
    assignments: db.inchargeAssignments.map(enrichAssignment),
    occupancy: snapshot(),
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

router.post('/incharge-assignments', (req, res) => {
  const db = getDb()
  const { riderId, scopeType, busId, stopId } = req.body || {}
  const rider = db.users.find(u => u.id === riderId)
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
  const stop = { id: nextId(), name: String(name).trim(), timeline: rows, busIds: [] }
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

  const bus = { id: nextId(), name: String(name).trim(), capacity: cap, stopIds: ids }
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

export default router
