import { app } from './src/app.js'
import { getDb, occupancyOf } from './src/db.js'
import { handleDetection, snapshot } from './src/services/occupancy.js'
import { setIo } from './src/realtime.js'

const server = app.listen(0)
const base = `http://127.0.0.1:${server.address().port}/api`

let passed = 0
let failed = 0

function check(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log(`  ok - ${name}`)
  } else {
    failed++
    console.error(`  FAIL - ${name} ${extra}`)
  }
}

async function call(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

const adminLogin = () => call('/auth/login', { method: 'POST', body: { email: 'admin@campus.edu', password: 'admin123' } }).then(r => r.data.token)

async function main() {
  const realtimeEvents = []
  setIo({
    emit(event, payload) {
      realtimeEvents.push({ room: 'all', event, payload })
    },
    to(room) {
      return { emit: (event, payload) => realtimeEvents.push({ room, event, payload }) }
    }
  })

  console.log('Smoke test: end-to-end workflow, concurrency, count invariants and realtime scope')

  const health = await call('/health')
  check('health endpoint', health.status === 200)

  const meta = await call('/meta')
  check('stops seeded for pagination demo (>= 10)', meta.status === 200 && meta.data.stops.length >= 10, `got ${meta.data.stops?.length}`)

  const login = await call('/auth/login', { method: 'POST', body: { email: 'rider@campus.edu', password: 'rider123' } })
  check('rider login', login.status === 200 && login.data.token)
  const rider = login.data.token

  let ov = (await call('/rider/overview', { token: rider })).data
  check('rider sees relevant buses', ov.buses.length === 2, `got ${ov.buses.length}`)
  const bus1 = ov.buses[0]
  check('initial counts all zero', bus1.availableSeats === bus1.capacity && bus1.seatsOccupied === 0 && bus1.softHolds === 0)

  const noAuth = await fetch(`${base}/rider/overview`).then(r => r.status)
  check('unauthenticated request blocked', noAuth === 401)

  console.log('FIX 1: one report state per rider/bus/trip')

  const rapidHolds = await Promise.all(Array.from({ length: 8 }, () =>
    call('/rider/soft-hold', { method: 'POST', token: rider, body: { busId: bus1.busId, response: 'yes' } })
  ))
  check('rapid simultaneous Soft Holds are accepted/idempotent', rapidHolds.every(r => r.status === 200))
  ov = (await call('/rider/overview', { token: rider })).data
  let b = ov.buses.find(x => x.busId === bus1.busId)
  check('soft hold increments hold count', b.softHolds === 1)
  check('available reduced by soft hold', b.availableSeats === b.capacity - 1)

  await call('/rider/soft-hold', { method: 'POST', token: rider, body: { busId: bus1.busId, response: 'yes' } })
  ov = (await call('/rider/overview', { token: rider })).data
  b = ov.buses.find(x => x.busId === bus1.busId)
  check('duplicate soft hold is idempotent (no second count)', b.softHolds === 1)

  await call('/rider/soft-hold', { method: 'POST', token: rider, body: { busId: bus1.busId, response: 'no' } })
  ov = (await call('/rider/overview', { token: rider })).data
  b = ov.buses.find(x => x.busId === bus1.busId)
  check('soft-hold "no" does not cancel or downgrade', b.softHolds === 1)

  const rapidDetections = await Promise.all(Array.from({ length: 8 }, () =>
    call('/rider/ble/simulate', { method: 'POST', token: rider, body: { busId: bus1.busId } })
  ))
  const sim = rapidDetections[0]
  check('BLE simulation creates prompt', sim.status === 200 && sim.data.prompts.length === 1)
  check('rapid BLE detections reuse one pending prompt',
    rapidDetections.every(r => r.status === 200 && r.data.prompts.length === 1 && r.data.prompts[0].id === sim.data.prompts[0].id))
  const prompt = sim.data.prompts[0]

  const rapidResponses = await Promise.all(Array.from({ length: 8 }, () =>
    call(`/rider/prompts/${prompt.id}/respond`, { method: 'POST', token: rider, body: { response: 'yes' } })
  ))
  const resp = rapidResponses.find(r => r.status === 200)
  check('BLE yes promotes soft_hold to seats_occupied', resp.status === 200 && resp.data.promoted === true)
  check('simultaneous prompt answers accept exactly one',
    rapidResponses.filter(r => r.status === 200).length === 1 && rapidResponses.filter(r => r.status === 409).length === 7)
  check('answered prompt is cleared live for every session of that rider',
    realtimeEvents.some(e => e.room === `user:${login.data.user.id}` && e.event === 'prompts' && e.payload.length === 0) &&
    realtimeEvents.some(e => e.room === `user:${login.data.user.id}` && e.event === 'refresh'))

  ov = (await call('/rider/overview', { token: rider })).data
  b = ov.buses.find(x => x.busId === bus1.busId)
  check('promotion: holds released, occupied 1', b.softHolds === 0 && b.seatsOccupied === 1)
  check('stop marked as passed on bus path', b.passedStopIds.length === 1)

  const replay = await call(`/rider/prompts/${prompt.id}/respond`, { method: 'POST', token: rider, body: { response: 'yes' } })
  check('answering same prompt twice rejected', replay.status === 409)

  const lateSim = await call('/rider/ble/simulate', { method: 'POST', token: rider, body: { busId: bus1.busId } })
  check('BLE detection blocked after boarding (409)', lateSim.status === 409)

  const lateHold = await call('/rider/soft-hold', { method: 'POST', token: rider, body: { busId: bus1.busId, response: 'yes' } })
  check('soft hold blocked after boarding (409)', lateHold.status === 409)

  ov = (await call('/rider/overview', { token: rider })).data
  b = ov.buses.find(x => x.busId === bus1.busId)
  check('counts unchanged by all duplicate attempts', b.seatsOccupied === 1 && b.softHolds === 0)
  check('overview exposes boarded state', ov.boardedBusIds.includes(bus1.busId))
  check('rider no longer holds soft hold state', !ov.softHoldBusIds.includes(bus1.busId))

  const login2 = await call('/auth/login', { method: 'POST', body: { email: 'rider2@campus.edu', password: 'rider123' } })
  const rider2 = login2.data.token
  const ov2 = (await call('/rider/overview', { token: rider2 })).data
  check('downstream rider received arrival broadcast', ov2.notifications.some(n => n.message.includes('has reported at')))

  const directBoard = await call('/rider/ble/simulate', { method: 'POST', token: rider2, body: { busId: bus1.busId } })
  const p2 = directBoard.data.prompts[0]
  await call(`/rider/prompts/${p2.id}/respond`, { method: 'POST', token: rider2, body: { response: 'yes' } })
  let adminTok = await adminLogin()
  let occ = (await call('/admin/overview', { token: adminTok })).data.occupancy.find(o => o.busId === bus1.busId)
  check('direct BLE board without soft hold adds occupied only', occ.seatsOccupied === 2 && occ.softHolds === 0)
  check('baseOccupied tracks rider states', occ.baseOccupied === 2 && occ.manualAdjustment === 0)

  console.log('FIX 2: authority-based incharge + Seats Available editing')

  const incLogin = await call('/auth/login', { method: 'POST', body: { email: 'incharge@campus.edu', password: 'incharge123' } })
  check('former incharge account is a rider now', incLogin.status === 200 && incLogin.data.user.role === 'rider')
  const incharge = incLogin.data.token
  const incOv = (await call('/rider/overview', { token: incharge })).data
  check('authority resolved via assignment (bus scope)', incOv.authorityBusIds.includes(bus1.busId))
  check('authority bus visible with controls flag', incOv.buses.find(x => x.busId === bus1.busId)?.inchargeAuthority === true)

  const oldRoleRoute = await call('/incharge/overview', { token: incharge })
  check('separate incharge login surface removed', oldRoleRoute.status === 401 || oldRoleRoute.status === 403 || oldRoleRoute.status === 404)

  const rider3Login = await call('/auth/login', { method: 'POST', body: { email: 'rider3@campus.edu', password: 'rider123' } })
  const rider3 = rider3Login.data.token
  const noAuth2 = await call(`/rider/incharge/buses/${bus1.busId}/available`, { method: 'POST', token: rider3, body: { seatsAvailable: 30 } })
  check('rider without authority cannot edit Seats Available', noAuth2.status === 403)

  const badAvail = await call(`/rider/incharge/buses/${bus1.busId}/available`, { method: 'POST', token: incharge, body: { seatsAvailable: 999 } })
  check('Seats Available above capacity rejected', badAvail.status === 400)

  const override = await call(`/rider/incharge/buses/${bus1.busId}/available`, { method: 'POST', token: incharge, body: { seatsAvailable: 35 } })
  check('authority holder edits Seats Available', override.status === 200)
  check('occupied back-calculated: 40-35-0 = 5', override.data.override.newOccupied === 5 && override.data.override.previousOccupied === 2)

  occ = (await call('/admin/overview', { token: adminTok })).data.occupancy.find(o => o.busId === bus1.busId)
  check('derived occupied visible in occupancy', occ.seatsOccupied === 5 && occ.availableSeats === 35)
  check('manual adjustment recorded', occ.manualAdjustment === 3 && occ.baseOccupied === 2)

  const rider3Board = await call('/rider/ble/simulate', { method: 'POST', token: rider3, body: { busId: bus1.busId } })
  const p3 = rider3Board.data.prompts[0]
  await call(`/rider/prompts/${p3.id}/respond`, { method: 'POST', token: rider3, body: { response: 'yes' } })
  occ = (await call('/admin/overview', { token: adminTok })).data.occupancy.find(o => o.busId === bus1.busId)
  check('new boarding after correction: base 3 + adj 3 = 6', occ.seatsOccupied === 6 && occ.availableSeats === 34)

  const grantToRider2 = await call('/admin/incharge-assignments', {
    method: 'POST', token: adminTok,
    body: { riderId: (await call('/me', { token: rider2 })).data.user.id, scopeType: 'bus', busId: ov.buses.find(x => x.busId !== bus1.busId).busId }
  })
  check('admin grants authority to rider live', grantToRider2.status === 201)
  const duplicateGrant = await call('/admin/incharge-assignments', {
    method: 'POST', token: adminTok,
    body: { riderId: (await call('/me', { token: rider2 })).data.user.id, scopeType: 'bus', busId: grantToRider2.data.assignment.busId }
  })
  check('duplicate active Incharge grant rejected', duplicateGrant.status === 409)
  const rider2Ov = (await call('/rider/overview', { token: rider2 })).data
  check('rider sees new authority immediately (no re-login)', rider2Ov.authorityBusIds.includes(grantToRider2.data.assignment.busId))

  const grantToAdmin = await call('/admin/incharge-assignments', {
    method: 'POST', token: adminTok,
    body: { riderId: (await call('/me', { token: adminTok })).data.user.id, scopeType: 'bus', busId: bus1.busId }
  })
  check('cannot grant authority to admin account', grantToAdmin.status === 400)

  const revoke = await call(`/admin/incharge-assignments/${grantToRider2.data.assignment.id}`, { method: 'DELETE', token: adminTok })
  check('admin revokes authority', revoke.status === 200 && revoke.data.assignment.revokedAt)
  const rider2OvAfter = (await call('/rider/overview', { token: rider2 })).data
  check('revoked authority disappears from rider view', !rider2OvAfter.authorityBusIds.includes(grantToRider2.data.assignment.busId))

  const doubleRevoke = await call(`/admin/incharge-assignments/${grantToRider2.data.assignment.id}`, { method: 'DELETE', token: adminTok })
  check('double revoke rejected', doubleRevoke.status === 409)

  console.log('audit trail integrity')

  let adminOv = (await call('/admin/overview', { token: adminTok })).data
  check('audit contains rejected duplicate attempts', adminOv.audit.some(a => a.kind === 'report_attempt' && a.outcome === 'rejected_already_boarded'))
  check('audit contains accepted promotion attempt', adminOv.audit.some(a => a.kind === 'report_attempt' && a.outcome === 'accepted_promotion'))
  check('audit contains arrival event', adminOv.audit.some(a => a.kind === 'arrival_event'))
  check('audit contains Seats Available override', adminOv.audit.some(a => a.kind === 'incharge_override' && a.detail.includes('Seats Available')))
  check('audit contains assignment grant + revoke', adminOv.audit.filter(a => a.kind === 'incharge_assignment').length >= 3)
  check('authority revocation is attributed to the acting admin',
    adminOv.audit.some(a => a.kind === 'incharge_assignment' && a.detail.startsWith('Revoked') && a.actor === 'Admin'))
  check('audit realtime feed is scoped to admins only',
    realtimeEvents.some(e => e.room === 'role:admin' && e.event === 'audit') &&
    !realtimeEvents.some(e => e.room === 'all' && e.event === 'audit'))
  check('arrival realtime event is scoped to admins; riders use targeted notifications',
    realtimeEvents.some(e => e.room === 'role:admin' && e.event === 'arrival') &&
    !realtimeEvents.some(e => e.room === 'all' && e.event === 'arrival'))

  console.log('admin CRUD + registration rules')

  const newStop = await call('/admin/stops', { method: 'POST', token: adminTok, body: { name: 'Test Gate', timeline: [{ time: '09:00', label: 'Evening' }] } })
  check('admin creates stop', newStop.status === 201)

  const linkedOnCreate = await call('/admin/stops', {
    method: 'POST', token: adminTok,
    body: { name: 'Linked Gate', timeline: [], busIds: [bus1.busId] }
  })
  const afterLinkedCreate = (await call('/admin/overview', { token: adminTok })).data
  check('stop creation accepts and synchronizes linked buses',
    linkedOnCreate.status === 201 && linkedOnCreate.data.stop.busIds.includes(bus1.busId) &&
    afterLinkedCreate.buses.find(item => item.id === bus1.busId).stopIds.includes(linkedOnCreate.data.stop.id))

  const newBus = await call('/admin/buses', {
    method: 'POST', token: adminTok,
    body: { name: 'Test-99', capacity: 10, stopIds: [newStop.data.stop.id] }
  })
  check('admin creates bus linked to stop', newBus.status === 201)
  adminOv = (await call('/admin/overview', { token: adminTok })).data
  check('link synced bidirectionally',
    adminOv.stops.find(s => s.id === newStop.data.stop.id).busIds.includes(newBus.data.bus.id) &&
    adminOv.buses.find(x => x.id === newBus.data.bus.id).stopIds.includes(newStop.data.stop.id))

  const regBad = await call('/auth/register', {
    method: 'POST',
    body: { name: 'X', email: 'x@campus.edu', password: 'pass1234', role: 'incharge', stopIds: [newStop.data.stop.id] }
  })
  check('registering as incharge role rejected', regBad.status === 400)

  const reg = await call('/auth/register', {
    method: 'POST',
    body: { name: 'New Rider', email: 'new@campus.edu', password: 'pass1234', role: 'rider', stopIds: [newStop.data.stop.id] }
  })
  check('rider registration works', reg.status === 201)
  const newRiderOv = (await call('/rider/overview', { token: reg.data.token })).data
  check('new rider auto-resolves bus from stop', newRiderOv.buses.some(b => b.busId === newBus.data.bus.id))

  const grantNewBus = await call('/admin/incharge-assignments', {
    method: 'POST', token: adminTok,
    body: { riderId: incLogin.data.user.id, scopeType: 'bus', busId: newBus.data.bus.id }
  })
  check('existing rider can receive another scoped Incharge authority', grantNewBus.status === 201)

  const newHold = await call('/rider/soft-hold', {
    method: 'POST', token: reg.data.token,
    body: { busId: newBus.data.bus.id, response: 'yes' }
  })
  check('Soft Hold can be placed on newly linked bus', newHold.status === 200)

  const impossibleAvailability = await call(`/rider/incharge/buses/${newBus.data.bus.id}/available`, {
    method: 'POST', token: incharge, body: { seatsAvailable: newBus.data.bus.capacity }
  })
  check('Seats Available cannot contradict an active Soft Hold', impossibleAvailability.status === 400)
  const afterImpossible = (await call('/admin/overview', { token: adminTok })).data.occupancy
    .find(item => item.busId === newBus.data.bus.id)
  check('rejected correction leaves the live count invariant intact',
    afterImpossible.softHolds === 1 && afterImpossible.availableSeats === newBus.data.bus.capacity - 1)

  const fillBus = await call(`/rider/incharge/buses/${newBus.data.bus.id}/available`, {
    method: 'POST', token: incharge, body: { seatsAvailable: 0 }
  })
  check('Incharge can derive a full bus while preserving the active Soft Hold',
    fillBus.status === 200 && fillBus.data.override.newOccupied === newBus.data.bus.capacity - 1)

  const reg2 = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Concurrent Rider', email: 'concurrent@campus.edu', password: 'pass1234', role: 'rider', stopIds: [newStop.data.stop.id] }
  })
  const fullHold = await call('/rider/soft-hold', {
    method: 'POST', token: reg2.data.token,
    body: { busId: newBus.data.bus.id, response: 'yes' }
  })
  check('full bus rejects another Soft Hold without inflating counts', fullHold.status === 409)

  const fullDetect = await call('/rider/ble/simulate', {
    method: 'POST', token: reg2.data.token, body: { busId: newBus.data.bus.id }
  })
  const fullBoard = await call(`/rider/prompts/${fullDetect.data.prompts[0].id}/respond`, {
    method: 'POST', token: reg2.data.token, body: { response: 'yes' }
  })
  check('full bus rejects direct BLE boarding without creating an arrival', fullBoard.status === 409)

  const heldDetect = await call('/rider/ble/simulate', {
    method: 'POST', token: reg.data.token, body: { busId: newBus.data.bus.id }
  })
  const heldBoard = await call(`/rider/prompts/${heldDetect.data.prompts[0].id}/respond`, {
    method: 'POST', token: reg.data.token, body: { response: 'yes' }
  })
  const afterPromotion = (await call('/admin/overview', { token: adminTok })).data.occupancy
    .find(item => item.busId === newBus.data.bus.id)
  check('Soft Hold promotion still succeeds on a full bus with no net availability change',
    heldBoard.status === 200 && heldBoard.data.promoted && afterPromotion.softHolds === 0 &&
    afterPromotion.seatsOccupied === newBus.data.bus.capacity && afterPromotion.availableSeats === 0)

  const lowerCapacity = await call(`/admin/buses/${newBus.data.bus.id}`, {
    method: 'PUT', token: adminTok, body: { capacity: newBus.data.bus.capacity - 1 }
  })
  check('capacity cannot be reduced below current occupied-plus-held seats', lowerCapacity.status === 409)

  let invalidDetectionRejected = false
  try {
    handleDetection({
      userId: reg2.data.user.id,
      busId: bus1.busId,
      stopId: linkedOnCreate.data.stop.id
    })
  } catch {
    invalidDetectionRejected = true
  }
  check('shared BLE gateway rejects a rider/stop/bus topology mismatch', invalidDetectionRejected)

  const rolloverOcc = occupancyOf(newBus.data.bus.id)
  rolloverOcc.tripDate = '1900-01-01'
  rolloverOcc.manualAdjustment = 7
  const rolled = snapshot().find(item => item.busId === newBus.data.bus.id)
  check('manual Incharge adjustment resets at trip-day rollover',
    rolled.manualAdjustment === 0 && rolled.tripDate !== '1900-01-01')

  const blankName = await call('/auth/register', {
    method: 'POST',
    body: { name: '   ', email: 'blank@campus.edu', password: 'pass1234', role: 'rider', stopIds: [newStop.data.stop.id] }
  })
  check('registration rejects whitespace-only rider names', blankName.status === 400)

  const normalized = await call('/auth/register', {
    method: 'POST',
    body: { name: '  Trimmed Rider  ', email: '  TRIMMED@CAMPUS.EDU  ', password: 'pass1234', role: 'rider', stopIds: [newStop.data.stop.id] }
  })
  check('registration normalizes rider name and email',
    normalized.status === 201 && normalized.data.user.name === 'Trimmed Rider' && normalized.data.user.email === 'trimmed@campus.edu')

  const forbidden = await call('/admin/stops', { method: 'POST', token: rider, body: { name: 'Hack' } })
  check('rider blocked from admin endpoints', forbidden.status === 403)

  console.log(`\n${passed} passed, ${failed} failed`)
  server.close()
  process.exit(failed ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  server.close()
  process.exit(1)
})
