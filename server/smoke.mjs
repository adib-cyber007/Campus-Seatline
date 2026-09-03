import { app } from './src/app.js'
import {
  getDb, effectiveStopIdsForUser, resetDatabase, runDatabaseTransaction, nextId, todayKey
} from './src/db.js'
import { handleDetection, snapshot } from './src/services/occupancy.js'
import { answerAdminQuestion, adminReadSnapshot } from './src/services/adminAssistant.js'
import { sendPushIfUserOffline } from './src/services/push.js'
import { setIo } from './src/realtime.js'

if (process.env.SEATLINE_TEST_SCHEMA !== 'seatline_test') {
  throw new Error('Refusing to reset a non-test database. Run this test through npm run smoke.')
}

await resetDatabase()
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

async function createManagedUser(adminToken, body) {
  const created = await call('/admin/users', { method: 'POST', token: adminToken, body })
  if (created.status !== 201) return created
  const login = await call('/auth/login', {
    method: 'POST', body: { email: body.email.trim().toLowerCase(), password: body.password }
  })
  return {
    status: created.status,
    data: { user: created.data.user, token: login.data.token }
  }
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

  // Activation-time auto-holds are tested in trips-smoke. Release seed-account
  // holds here so the legacy morning suite keeps its original zero-count fixture.
  await runDatabaseTransaction(() => {
    const seedUserIds = new Set(getDb().users
      .filter(user => ['incharge@campus.edu', 'rider2@campus.edu', 'rider3@campus.edu'].includes(user.email))
      .map(user => user.id))
    const now = new Date().toISOString()
    for (const report of getDb().boardingReports.filter(item =>
      seedUserIds.has(item.userId) && item.source === 'auto' && item.state === 'soft_hold'
    )) {
      report.state = 'released'
      report.releaseReason = 'legacy_smoke_fixture_reset'
      report.releasedAt = now
      report.updatedAt = now
    }
    getDb().autoHoldEvaluations = getDb().autoHoldEvaluations
      .filter(item => !seedUserIds.has(item.userId))
  })

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
  const publicRegistration = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Public Signup', email: 'public-signup@campus.edu', password: 'pass1234', role: 'rider', stopIds: [bus1.stopIds[0]] }
  })
  check('self-service registration route does not exist', publicRegistration.status === 404)

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

  const otherBus = ov.buses.find(item => item.busId !== bus1.busId)
  let adminTok = await adminLogin()
  const earlyAdminOverview = (await call('/admin/overview', { token: adminTok })).data
  const rawBus1 = earlyAdminOverview.buses.find(item => item.id === bus1.busId)
  const rawOtherBus = earlyAdminOverview.buses.find(item => item.id === otherBus.busId)
  check('server-assigned 128-bit service UUIDs are visible in Admin data only',
    Boolean(rawBus1.beacon?.serviceUuid) && Boolean(rawOtherBus.beacon?.serviceUuid) &&
    rawBus1.beacon.serviceUuid !== rawOtherBus.beacon.serviceUuid &&
    rawBus1.beacon.advertisingMode === 'legacy')
  check('Rider overview exposes only BLE eligibility and never a raw bus UUID',
    bus1.bleEligible === true && otherBus.bleEligible === true &&
    !JSON.stringify(ov).includes(rawBus1.beacon.serviceUuid) &&
    !JSON.stringify(ov).includes(rawOtherBus.beacon.serviceUuid) &&
    !Object.prototype.hasOwnProperty.call(bus1, 'beacon'))

  const invalidBeacon = await call('/rider/ble/detected', {
    method: 'POST', token: rider,
    body: { busId: bus1.busId, beacon: { format: 'ibeacon', uuid: 'invalid', major: 1, minor: 1 } }
  })
  check('external BLE endpoint rejects malformed or unsupported beacon identity', invalidBeacon.status === 400)

  const unknownBeacon = await call('/rider/ble/detected', {
    method: 'POST', token: rider,
    body: {
      busId: bus1.busId,
      beacon: { format: 'service_uuid', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', rssi: -58 }
    }
  })
  check('server rejects a valid UUID that is not assigned to any bus',
    unknownBeacon.status === 422 && unknownBeacon.data.code === 'UNKNOWN_BEACON_UUID')

  const mismatchBeacon = await call('/rider/ble/detected', {
    method: 'POST', token: rider,
    body: {
      busId: bus1.busId,
      beacon: { format: 'service_uuid', uuid: rawOtherBus.beacon.serviceUuid, rssi: -58 }
    }
  })
  check('server rejects a beacon UUID submitted for the wrong bus before creating a prompt',
    mismatchBeacon.status === 409 && mismatchBeacon.data.code === 'BEACON_BUS_MISMATCH' &&
    getDb().prompts.every(item => item.userId !== login.data.user.id))

  const externalDetection = await call('/rider/ble/detected', {
    method: 'POST',
    token: rider,
    body: {
      beacon: { format: 'service_uuid', uuid: rawBus1.beacon.serviceUuid, rssi: -54 }
    }
  })
  check('legitimate matched service UUID creates the canonical BLE prompt',
    externalDetection.status === 200 && externalDetection.data.source === 'service_uuid' &&
    externalDetection.data.prompts[0].detectionSource === 'service_uuid' &&
    externalDetection.data.prompts[0].busId === bus1.busId &&
    !JSON.stringify(externalDetection.data.prompts[0]).includes(rawBus1.beacon.serviceUuid))

  const serviceUuidDetection = await call('/rider/ble/detected', {
    method: 'POST',
    token: rider,
    body: {
      beacon: {
        format: 'service_uuid',
        uuid: rawBus1.beacon.serviceUuid,
        rssi: -54
      }
    }
  })
  check('privacy-safe service UUID detection reuses the canonical prompt',
    serviceUuidDetection.status === 200 && serviceUuidDetection.data.source === 'service_uuid' &&
    serviceUuidDetection.data.prompts[0].id === externalDetection.data.prompts[0].id)

  const rapidDetections = await Promise.all(Array.from({ length: 8 }, () =>
    call('/rider/ble/simulate', { method: 'POST', token: rider, body: { busId: bus1.busId } })
  ))
  const sim = externalDetection
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
  const inchargeDetection = await call('/rider/ble/detected', {
    method: 'POST', token: incharge,
    body: { beacon: { format: 'service_uuid', uuid: rawBus1.beacon.serviceUuid, rssi: -61 } }
  })
  const inchargeAfterDetection = (await call('/rider/overview', { token: incharge })).data
  const inchargeDiagnosticBus = inchargeAfterDetection.buses.find(item => item.busId === bus1.busId)
  check('Incharge receives a useful BLE recency diagnostic with no raw UUID',
    inchargeDetection.status === 200 && Boolean(inchargeDiagnosticBus.bleDiagnostic?.lastDetectedAt) &&
    inchargeDiagnosticBus.bleDiagnostic.lastDetectionStatus === 'pending' &&
    !JSON.stringify(inchargeAfterDetection).includes(rawBus1.beacon.serviceUuid))

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
  check('new bus receives a unique server-owned BLE identity',
    Boolean(newBus.data.bus.beacon?.serviceUuid) &&
    adminOv.buses.filter(item => item.id !== newBus.data.bus.id)
      .every(item => item.beacon?.serviceUuid !== newBus.data.bus.beacon.serviceUuid))

  const attemptedBeaconOverwrite = await call(`/admin/buses/${newBus.data.bus.id}`, {
    method: 'PUT', token: adminTok,
    body: { beacon: { serviceUuid: '00000000-0000-4000-8000-000000000001' } }
  })
  check('bus edits cannot overwrite the server-owned BLE identity',
    attemptedBeaconOverwrite.status === 200 &&
    attemptedBeaconOverwrite.data.bus.beacon.serviceUuid === newBus.data.bus.beacon.serviceUuid)

  const regBad = await call('/admin/users', {
    method: 'POST', token: adminTok,
    body: { name: 'X', email: 'x@campus.edu', password: 'pass1234', role: 'incharge', stopIds: [newStop.data.stop.id] }
  })
  check('provisioning a separate Incharge role is rejected', regBad.status === 400)

  const reg = await createManagedUser(adminTok,
    { name: 'New Rider', email: 'new@campus.edu', password: 'pass1234', role: 'rider', stopIds: [newStop.data.stop.id] })
  check('Admin-provisioned rider account works', reg.status === 201)
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

  const reg2 = await createManagedUser(adminTok,
    { name: 'Concurrent Rider', email: 'concurrent@campus.edu', password: 'pass1234', role: 'rider', stopIds: [newStop.data.stop.id] })
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

  const tripScopedAdjustment = snapshot().find(item => item.busId === newBus.data.bus.id).manualAdjustment
  getDb().occupancy[newBus.data.bus.id] = {
    busId: newBus.data.bus.id, tripDate: '1900-01-01', manualAdjustment: 7,
    lastUpdated: new Date().toISOString()
  }
  const rolled = snapshot().find(item => item.busId === newBus.data.bus.id)
  check('legacy bus-day adjustment cannot carry into the active Trip',
    rolled.manualAdjustment === tripScopedAdjustment && rolled.tripDate !== '1900-01-01' && Boolean(rolled.tripId))

  const blankName = await call('/admin/users', {
    method: 'POST', token: adminTok,
    body: { name: '   ', email: 'blank@campus.edu', password: 'pass1234', role: 'rider', stopIds: [newStop.data.stop.id] }
  })
  check('Admin provisioning rejects whitespace-only rider names', blankName.status === 400)

  const normalized = await call('/admin/users', {
    method: 'POST', token: adminTok,
    body: { name: '  Trimmed Rider  ', email: '  TRIMMED@CAMPUS.EDU  ', password: 'pass1234', role: 'rider', stopIds: [newStop.data.stop.id] }
  })
  check('Admin provisioning normalizes rider name and email',
    normalized.status === 201 && normalized.data.user.name === 'Trimmed Rider' && normalized.data.user.email === 'trimmed@campus.edu')

  console.log('UPDATE 3: Admin-provisioned accounts and dependency-safe retirement')

  const createdAdmin = await call('/admin/users', {
    method: 'POST', token: adminTok,
    body: { name: 'Relief Dispatcher', email: 'relief-admin@campus.edu', password: 'dispatch123', role: 'admin', stopIds: [newStop.data.stop.id] }
  })
  const createdAdminLogin = await call('/auth/login', {
    method: 'POST', body: { email: 'relief-admin@campus.edu', password: 'dispatch123' }
  })
  check('Admin can provision another Admin with an initial password and no stop assignment',
    createdAdmin.status === 201 && createdAdmin.data.user.role === 'admin' &&
    createdAdmin.data.user.stopIds.length === 0 && !createdAdmin.data.user.passwordHash &&
    createdAdminLogin.status === 200)
  const riderCreateDenied = await call('/admin/users', {
    method: 'POST', token: rider,
    body: { name: 'Denied User', email: 'denied-user@campus.edu', password: 'pass1234', role: 'rider', stopIds: [newStop.data.stop.id] }
  })
  check('Riders and riders with Incharge authority cannot provision accounts', riderCreateDenied.status === 403)

  const managedRider = await call('/admin/users', {
    method: 'POST', token: adminTok,
    body: { name: 'Managed Rider', email: 'managed-rider@campus.edu', password: 'managed123', role: 'rider', stopIds: [newStop.data.stop.id] }
  })
  const managedAssignment = await call('/admin/incharge-assignments', {
    method: 'POST', token: adminTok,
    body: { riderId: managedRider.data.user.id, scopeType: 'stop', stopId: newStop.data.stop.id }
  })
  const managedRemoval = await call(`/admin/users/${managedRider.data.user.id}`, {
    method: 'DELETE', token: adminTok
  })
  const managedLoginAfterRemoval = await call('/auth/login', {
    method: 'POST', body: { email: 'managed-rider@campus.edu', password: 'managed123' }
  })
  const afterManagedRemoval = (await call('/admin/overview', { token: adminTok })).data
  check('retiring a Rider atomically revokes active Incharge authority without dangling access',
    managedRemoval.status === 200 && managedRemoval.data.archived === true &&
    managedRemoval.data.revokedAssignmentIds.includes(managedAssignment.data.assignment.id) &&
    getDb().inchargeAssignments.find(item => item.id === managedAssignment.data.assignment.id)?.revokedAt)
  check('a retired account cannot log in and disappears from the active identity ledger',
    managedLoginAfterRemoval.status === 401 &&
    !afterManagedRemoval.users.some(user => user.id === managedRider.data.user.id))
  check('retired account identity and authority history remain available in the audit trail',
    afterManagedRemoval.audit.some(item => item.kind === 'user_archived' && item.detail.includes('Managed Rider')) &&
    afterManagedRemoval.audit.some(item => item.kind === 'incharge_assignment' && item.detail.includes('Managed Rider') && item.detail.startsWith('Revoked')))

  const protectedStop = await call('/admin/stops', {
    method: 'POST', token: adminTok, body: { name: 'Protected Account Gate', timeline: [], busIds: [] }
  })
  const protectedBus = await call('/admin/buses', {
    method: 'POST', token: adminTok,
    body: { name: 'Protected Account Shuttle', capacity: 5, stopIds: [protectedStop.data.stop.id] }
  })
  const protectedRider = await call('/admin/users', {
    method: 'POST', token: adminTok,
    body: { name: 'Protected Active Rider', email: 'protected-rider@campus.edu', password: 'protected123', role: 'rider', stopIds: [protectedStop.data.stop.id] }
  })
  const protectedLogin = await call('/auth/login', {
    method: 'POST', body: { email: 'protected-rider@campus.edu', password: 'protected123' }
  })
  await call('/rider/soft-hold', {
    method: 'POST', token: protectedLogin.data.token,
    body: { busId: protectedBus.data.bus.id, response: 'yes' }
  })
  const protectedRemoval = await call(`/admin/users/${protectedRider.data.user.id}`, {
    method: 'DELETE', token: adminTok
  })
  check('account removal is blocked with a clear dependency while an active trip report exists',
    protectedRemoval.status === 409 && protectedRemoval.data.dependencies.activeReports === 1 &&
    getDb().users.find(user => user.id === protectedRider.data.user.id)?.active !== false)
  await call('/rider/soft-hold/release', {
    method: 'POST', token: protectedLogin.data.token, body: { busId: protectedBus.data.bus.id }
  })
  const releasedRemoval = await call(`/admin/users/${protectedRider.data.user.id}`, {
    method: 'DELETE', token: adminTok
  })
  check('account can be safely retired after the operational dependency is resolved',
    releasedRemoval.status === 200 && getDb().users.find(user => user.id === protectedRider.data.user.id)?.active === false)

  console.log('CHANGE 1: global Soft Hold transfer and atomic BLE bus switch')

  const transferStop = await call('/admin/stops', {
    method: 'POST', token: adminTok,
    body: { name: 'Transfer Test Gate', timeline: [{ time: '10:00', label: 'Test trip' }], busIds: [] }
  })
  const transferBusA = await call('/admin/buses', {
    method: 'POST', token: adminTok,
    body: { name: 'Transfer-A', capacity: 12, stopIds: [transferStop.data.stop.id] }
  })
  const transferBusB = await call('/admin/buses', {
    method: 'POST', token: adminTok,
    body: { name: 'Transfer-B', capacity: 12, stopIds: [transferStop.data.stop.id] }
  })
  const transferRider = await createManagedUser(adminTok,
    { name: 'Transfer Rider', email: 'transfer@campus.edu', password: 'pass1234', role: 'rider', stopIds: [transferStop.data.stop.id] })
  let transferOverview = (await call('/rider/overview', { token: transferRider.data.token })).data
  check('multi-option rider is not auto-held', transferOverview.softHoldBusIds.length === 0)

  const holdA = await call('/rider/soft-hold', {
    method: 'POST', token: transferRider.data.token,
    body: { busId: transferBusA.data.bus.id, response: 'yes' }
  })
  check('rider creates Soft Hold on Bus A', holdA.status === 200)
  const beforeSwitch = snapshot()
  const beforeA = beforeSwitch.find(item => item.busId === transferBusA.data.bus.id)
  const beforeB = beforeSwitch.find(item => item.busId === transferBusB.data.bus.id)
  const eventStart = realtimeEvents.length

  const detectB = await call('/rider/ble/simulate', {
    method: 'POST', token: transferRider.data.token,
    body: { busId: transferBusB.data.bus.id }
  })
  const switchResponse = await call(`/rider/prompts/${detectB.data.prompts[0].id}/respond`, {
    method: 'POST', token: transferRider.data.token, body: { response: 'yes' }
  })
  const afterSwitch = snapshot()
  const afterA = afterSwitch.find(item => item.busId === transferBusA.data.bus.id)
  const afterB = afterSwitch.find(item => item.busId === transferBusB.data.bus.id)
  check('BLE switch is direct occupy on Bus B, not a promotion there',
    switchResponse.status === 200 && switchResponse.data.promoted === false &&
    switchResponse.data.transferredFromBusId === transferBusA.data.bus.id)
  check('BLE switch releases A hold and occupies B exactly once',
    afterA.softHolds === beforeA.softHolds - 1 &&
    afterB.seatsOccupied === beforeB.seatsOccupied + 1 && afterB.softHolds === beforeB.softHolds)

  const switchOccupancyEvents = realtimeEvents.slice(eventStart)
    .filter(event => event.event === 'occupancy')
  check('no realtime observer sees a half-completed transfer',
    switchOccupancyEvents.length > 0 && switchOccupancyEvents.every(event => {
      const a = event.payload.find(item => item.busId === transferBusA.data.bus.id)
      const b = event.payload.find(item => item.busId === transferBusB.data.bus.id)
      return a.softHolds === afterA.softHolds && b.seatsOccupied === afterB.seatsOccupied
    }))
  const activeTransferStates = getDb().boardingReports.filter(report =>
    report.userId === transferRider.data.user.id &&
    (report.state === 'soft_hold' || report.state === 'seats_occupied'))
  check('data layer exposes exactly one active global report state',
    activeTransferStates.length === 1 && activeTransferStates[0].busId === transferBusB.data.bus.id &&
    activeTransferStates[0].state === 'seats_occupied')
  check('old Bus A report is retained only as released history',
    getDb().boardingReports.some(report => report.userId === transferRider.data.user.id &&
      report.busId === transferBusA.data.bus.id && report.state === 'released'))

  const duplicateSwitchReports = await Promise.all([
    ...Array.from({ length: 5 }, () => call('/rider/ble/simulate', {
      method: 'POST', token: transferRider.data.token, body: { busId: transferBusB.data.bus.id }
    })),
    ...Array.from({ length: 5 }, () => call('/rider/soft-hold', {
      method: 'POST', token: transferRider.data.token,
      body: { busId: transferBusB.data.bus.id, response: 'yes' }
    }))
  ])
  const holdAfterOccupiedOnOther = await call('/rider/soft-hold', {
    method: 'POST', token: transferRider.data.token,
    body: { busId: transferBusA.data.bus.id, response: 'yes' }
  })
  const afterDuplicateSwitch = snapshot()
  check('rapid same-bus reports after occupation are all rejected',
    duplicateSwitchReports.every(result => result.status === 409))
  check('occupied rider cannot create a second active state on another bus', holdAfterOccupiedOnOther.status === 409)
  check('duplicate attempts do not inflate either switched bus',
    afterDuplicateSwitch.find(item => item.busId === transferBusA.data.bus.id).softHolds === afterA.softHolds &&
    afterDuplicateSwitch.find(item => item.busId === transferBusB.data.bus.id).seatsOccupied === afterB.seatsOccupied)

  console.log('CHANGE 2: single-option automatic Soft Hold with reusable release')

  const singleStop = await call('/admin/stops', {
    method: 'POST', token: adminTok,
    body: { name: 'Single Option Gate', timeline: [{ time: '11:00', label: 'Confirmed trip' }], busIds: [] }
  })
  const singleBus = await call('/admin/buses', {
    method: 'POST', token: adminTok,
    body: { name: 'Only-Option', capacity: 9, stopIds: [singleStop.data.stop.id] }
  })
  const autoRider = await createManagedUser(adminTok,
    { name: 'Automatic Hold Rider', email: 'auto-hold@campus.edu', password: 'pass1234', role: 'rider', stopIds: [singleStop.data.stop.id] })
  const simultaneousAutoOverviews = await Promise.all(Array.from({ length: 8 }, () =>
    call('/rider/overview', { token: autoRider.data.token })
  ))
  let autoOverview = simultaneousAutoOverviews[0].data
  const autoReports = getDb().boardingReports.filter(report =>
    report.userId === autoRider.data.user.id && report.tripDate === todayKey() && report.state === 'soft_hold'
  )
  const autoEvaluations = getDb().autoHoldEvaluations.filter(item =>
    item.userId === autoRider.data.user.id && item.tripDate === todayKey()
  )
  check('simultaneous first loads create exactly one automatic Soft Hold for a single-option rider',
    simultaneousAutoOverviews.every(result => result.status === 200) &&
    autoOverview.softHoldBusIds.length === 1 && autoOverview.softHoldBusIds[0] === singleBus.data.bus.id &&
    autoOverview.buses.find(item => item.busId === singleBus.data.bus.id).softHolds === 1 &&
    autoReports.length === 1 && autoReports[0].source === 'auto' && autoEvaluations.length === 1)
  check('auto-hold notification explains one-tap release',
    autoOverview.notifications.some(item => item.type === 'auto_hold' &&
      item.message.includes('automatically soft-held') && item.message.includes('tap Release')))

  const autoRelease = await call('/rider/soft-hold/release', {
    method: 'POST', token: autoRider.data.token, body: { busId: singleBus.data.bus.id }
  })
  autoOverview = (await call('/rider/overview', { token: autoRider.data.token })).data
  check('auto Soft Hold uses the same one-tap release endpoint',
    autoRelease.status === 200 && autoOverview.softHoldBusIds.length === 0 &&
    autoOverview.buses.find(item => item.busId === singleBus.data.bus.id).softHolds === 0)
  const autoOverviewAgain = (await call('/rider/overview', { token: autoRider.data.token })).data
  check('released auto-hold is not recreated on a later overview that day', autoOverviewAgain.softHoldBusIds.length === 0)
  check('auto-hold data contains no rider ranking fields',
    [...getDb().autoHoldEvaluations, ...getDb().boardingReports].every(item =>
      !Object.keys(item).some(key => /priority|rank|queue/i.test(key))))

  console.log('CHANGE 3: optional daily stop override and automatic default reversion')

  const overrideRider = await createManagedUser(adminTok,
    { name: 'Stop Override Rider', email: 'stop-override@campus.edu', password: 'pass1234', role: 'rider', stopIds: [transferStop.data.stop.id] })
  const overrideDefault = (await call('/rider/overview', { token: overrideRider.data.token })).data
  check('unused override preserves zero-action default stop context',
    !overrideDefault.dailyStopOverride && overrideDefault.stops[0].id === transferStop.data.stop.id)
  const setOverride = await call('/rider/daily-stop', {
    method: 'POST', token: overrideRider.data.token, body: { stopId: singleStop.data.stop.id }
  })
  let overriddenOverview = (await call('/rider/overview', { token: overrideRider.data.token })).data
  check('daily override changes only today effective stop, not registration',
    setOverride.status === 200 && overriddenOverview.stops[0].id === singleStop.data.stop.id &&
    overriddenOverview.defaultStops[0].id === transferStop.data.stop.id &&
    overriddenOverview.user.stopIds[0] === transferStop.data.stop.id)
  check('override routes bus options and auto-hold through overridden stop',
    overriddenOverview.buses.some(item => item.busId === singleBus.data.bus.id) &&
    !overriddenOverview.buses.some(item => item.busId === transferBusA.data.bus.id) &&
    overriddenOverview.softHoldBusIds.includes(singleBus.data.bus.id))
  const wrongContextDetection = await call('/rider/ble/simulate', {
    method: 'POST', token: overrideRider.data.token, body: { busId: transferBusA.data.bus.id }
  })
  const overrideDetection = await call('/rider/ble/simulate', {
    method: 'POST', token: overrideRider.data.token, body: { busId: singleBus.data.bus.id }
  })
  check('BLE reporting rejects the default stop while override is active', wrongContextDetection.status === 403)
  check('BLE prompt is routed to overridden stop',
    overrideDetection.status === 200 && overrideDetection.data.prompts[0].stopId === singleStop.data.stop.id)
  check('a different trip-day key automatically resolves back to registered stop',
    effectiveStopIdsForUser(overrideRider.data.user, '2099-01-01')[0] === transferStop.data.stop.id)

  const resetOverride = await call('/rider/daily-stop', { method: 'DELETE', token: overrideRider.data.token })
  overriddenOverview = (await call('/rider/overview', { token: overrideRider.data.token })).data
  check('reset returns routing to default without changing registration',
    resetOverride.status === 200 && !overriddenOverview.dailyStopOverride &&
    overriddenOverview.stops[0].id === transferStop.data.stop.id &&
    overriddenOverview.user.stopIds[0] === transferStop.data.stop.id)
  check('prompts from the former overridden stop are removed from active view',
    !overriddenOverview.prompts.some(promptItem => promptItem.stopId === singleStop.data.stop.id))

  console.log('FEATURE 1: derived stop rider counts include stop-scoped Incharge authority')

  const countStop = await call('/admin/stops', {
    method: 'POST', token: adminTok,
    body: { name: 'Count Verification Gate', timeline: [], busIds: [] }
  })
  const countedRider = await createManagedUser(adminTok,
    { name: 'Counted Home Rider', email: 'counted-home@campus.edu', password: 'pass1234', role: 'rider', stopIds: [countStop.data.stop.id] })
  let countOverview = (await call('/admin/overview', { token: adminTok })).data
  check('registering a rider increments the derived stop count',
    countOverview.stops.find(stop => stop.id === countStop.data.stop.id).riderCount === 1)
  check('Admin rider provisioning emits the existing live refresh signal',
    realtimeEvents.some(event => event.room === 'all' && event.event === 'refresh' && event.payload.reason === 'user-created'))

  const externalCountRiderId = (await call('/me', { token: rider2 })).data.user.id
  const externalStopGrant = await call('/admin/incharge-assignments', {
    method: 'POST', token: adminTok,
    body: { riderId: externalCountRiderId, scopeType: 'stop', stopId: countStop.data.stop.id }
  })
  countOverview = (await call('/admin/overview', { token: adminTok })).data
  check('outside rider with stop-scoped Incharge authority increases that stop count',
    countOverview.stops.find(stop => stop.id === countStop.data.stop.id).riderCount === 2)

  const registeredStopGrant = await call('/admin/incharge-assignments', {
    method: 'POST', token: adminTok,
    body: { riderId: countedRider.data.user.id, scopeType: 'stop', stopId: countStop.data.stop.id }
  })
  countOverview = (await call('/admin/overview', { token: adminTok })).data
  check('registered rider who is also Incharge is counted only once',
    countOverview.stops.find(stop => stop.id === countStop.data.stop.id).riderCount === 2)

  await call(`/admin/incharge-assignments/${externalStopGrant.data.assignment.id}`, { method: 'DELETE', token: adminTok })
  countOverview = (await call('/admin/overview', { token: adminTok })).data
  check('revoking an outside stop Incharge decreases the derived count',
    countOverview.stops.find(stop => stop.id === countStop.data.stop.id).riderCount === 1)
  await call(`/admin/incharge-assignments/${registeredStopGrant.data.assignment.id}`, { method: 'DELETE', token: adminTok })
  countOverview = (await call('/admin/overview', { token: adminTok })).data
  check('revoking a registered Incharge keeps their registration counted once',
    countOverview.stops.find(stop => stop.id === countStop.data.stop.id).riderCount === 1)

  console.log('FEATURE 2: dependency-safe Bus and Stop archive removal')

  const blockedBusArchive = await call(`/admin/buses/${bus1.busId}`, { method: 'DELETE', token: adminTok })
  check('bus removal is blocked while active rider state or Incharge authority exists',
    blockedBusArchive.status === 409 && blockedBusArchive.data.dependencies.activeRiders > 0 &&
    blockedBusArchive.data.error.includes('must be resolved first'))
  const blockedStopArchive = await call(`/admin/stops/${countStop.data.stop.id}`, { method: 'DELETE', token: adminTok })
  check('stop removal is blocked while registered riders remain',
    blockedStopArchive.status === 409 && blockedStopArchive.data.dependencies.registeredRiders === 1 &&
    blockedStopArchive.data.error.includes('registered riders'))

  const archiveBusStop = await call('/admin/stops', {
    method: 'POST', token: adminTok, body: { name: 'Archive Bus Gate', timeline: [], busIds: [] }
  })
  const archiveBus = await call('/admin/buses', {
    method: 'POST', token: adminTok, body: { name: 'Archive-Ready', capacity: 4, stopIds: [archiveBusStop.data.stop.id] }
  })
  const archiveRider = await createManagedUser(adminTok,
    { name: 'Archive History Rider', email: 'archive-history@campus.edu', password: 'pass1234', role: 'rider', stopIds: [archiveBusStop.data.stop.id] })
  await call('/rider/soft-hold', {
    method: 'POST', token: archiveRider.data.token, body: { busId: archiveBus.data.bus.id, response: 'yes' }
  })
  await call('/rider/soft-hold/release', {
    method: 'POST', token: archiveRider.data.token, body: { busId: archiveBus.data.bus.id }
  })
  const historicalBusReportId = getDb().boardingReports.find(report =>
    report.userId === archiveRider.data.user.id && report.busId === archiveBus.data.bus.id
  ).id
  const archiveBusResult = await call(`/admin/buses/${archiveBus.data.bus.id}`, { method: 'DELETE', token: adminTok })
  const afterBusArchive = (await call('/admin/overview', { token: adminTok })).data
  check('inactive bus archives cleanly after its active rider state is released',
    archiveBusResult.status === 200 && archiveBusResult.data.archived === true &&
    !afterBusArchive.buses.some(bus => bus.id === archiveBus.data.bus.id) &&
    getDb().buses.find(bus => bus.id === archiveBus.data.bus.id).active === false)
  check('bus archive preserves its released report and named audit history',
    getDb().boardingReports.some(report => report.id === historicalBusReportId && report.state === 'released') &&
    afterBusArchive.audit.some(item => item.kind === 'entity_archived' && item.detail.includes('Archive-Ready')) &&
    afterBusArchive.audit.some(item => item.kind === 'report_attempt' && item.detail.includes('Archive-Ready')))

  const archiveStop = await call('/admin/stops', {
    method: 'POST', token: adminTok, body: { name: 'Archive Empty Gate', timeline: [], busIds: [] }
  })
  const historicalStopAttemptId = nextId()
  await runDatabaseTransaction(() => {
    getDb().reportAttempts.push({
      id: historicalStopAttemptId, userId: login.data.user.id, busId: bus1.busId,
      stopId: archiveStop.data.stop.id, tripDate: todayKey(), channel: 'historical_fixture',
      requested: 'no', outcome: 'no_change', message: 'Historical stop retention fixture',
      timestamp: new Date().toISOString()
    })
  })
  const archiveStopResult = await call(`/admin/stops/${archiveStop.data.stop.id}`, { method: 'DELETE', token: adminTok })
  const afterStopArchive = (await call('/admin/overview', { token: adminTok })).data
  check('empty stop archives cleanly and disappears from all active views',
    archiveStopResult.status === 200 && archiveStopResult.data.archived === true &&
    !afterStopArchive.stops.some(stop => stop.id === archiveStop.data.stop.id) &&
    !(await call('/meta')).data.stops.some(stop => stop.id === archiveStop.data.stop.id) &&
    getDb().stops.find(stop => stop.id === archiveStop.data.stop.id).active === false)
  check('stop archive preserves historical report and audit references',
    getDb().reportAttempts.some(attempt => attempt.id === historicalStopAttemptId) &&
    afterStopArchive.audit.some(item => item.id === historicalStopAttemptId && item.detail.includes('Archive Empty Gate')) &&
    afterStopArchive.audit.some(item => item.kind === 'entity_archived' && item.detail.includes('Archive Empty Gate')))

  console.log('FEATURE 3: organized unmet-demand events and local read-only queries')

  const strandedStop = await call('/admin/stops', {
    method: 'POST', token: adminTok, body: { name: 'Stranded Demand Gate', timeline: [], busIds: [] }
  })
  const alternateStop = await call('/admin/stops', {
    method: 'POST', token: adminTok, body: { name: 'Alternative Demand Gate', timeline: [], busIds: [] }
  })
  const fullOnlyBus = await call('/admin/buses', {
    method: 'POST', token: adminTok, body: { name: 'Full-Only', capacity: 1, stopIds: [strandedStop.data.stop.id] }
  })
  const fullWithAltBus = await call('/admin/buses', {
    method: 'POST', token: adminTok, body: { name: 'Full-With-Alt', capacity: 1, stopIds: [alternateStop.data.stop.id] }
  })
  const openAlternateBus = await call('/admin/buses', {
    method: 'POST', token: adminTok, body: { name: 'Open-Alternate', capacity: 4, stopIds: [alternateStop.data.stop.id] }
  })
  const inchargeUserId = (await call('/me', { token: incharge })).data.user.id
  for (const targetBusId of [fullOnlyBus.data.bus.id, fullWithAltBus.data.bus.id]) {
    await call('/admin/incharge-assignments', {
      method: 'POST', token: adminTok, body: { riderId: inchargeUserId, scopeType: 'bus', busId: targetBusId }
    })
    await call(`/rider/incharge/buses/${targetBusId}/available`, {
      method: 'POST', token: incharge, body: { seatsAvailable: 0 }
    })
  }
  const strandedRider = await createManagedUser(adminTok,
    { name: 'Stranded Demand Rider', email: 'stranded-demand@campus.edu', password: 'pass1234', role: 'rider', stopIds: [strandedStop.data.stop.id] })
  const alternateRider = await createManagedUser(adminTok,
    { name: 'Alternative Demand Rider', email: 'alternative-demand@campus.edu', password: 'pass1234', role: 'rider', stopIds: [alternateStop.data.stop.id] })
  const strandedReject = await call('/rider/soft-hold', {
    method: 'POST', token: strandedRider.data.token, body: { busId: fullOnlyBus.data.bus.id, response: 'yes' }
  })
  const alternateDetection = await call('/rider/ble/simulate', {
    method: 'POST', token: alternateRider.data.token, body: { busId: fullWithAltBus.data.bus.id }
  })
  const alternateReject = await call(`/rider/prompts/${alternateDetection.data.prompts[0].id}/respond`, {
    method: 'POST', token: alternateRider.data.token, body: { response: 'yes' }
  })
  const demandOverview = (await call('/admin/overview', { token: adminTok })).data
  const strandedEvent = demandOverview.unmetDemand.events.find(event => event.userId === strandedRider.data.user.id)
  const alternateEvent = demandOverview.unmetDemand.events.find(event => event.userId === alternateRider.data.user.id)
  check('Soft Hold and BLE capacity rejections both create unmet-demand events',
    strandedReject.status === 409 && alternateReject.status === 409 &&
    strandedEvent?.channel === 'soft_intent' && alternateEvent?.channel === 'ble_confirmed')
  check('unmet-demand events distinguish stranded riders from viable alternatives',
    strandedEvent?.hadAlternateBus === false && strandedEvent?.alternateBusIds.length === 0 &&
    alternateEvent?.hadAlternateBus === true && alternateEvent?.alternateBusIds.includes(openAlternateBus.data.bus.id))
  check('Admin overview exposes aggregated stop–bus demand groups plus drill-down events',
    demandOverview.unmetDemand.summary.some(group =>
      group.stopId === strandedStop.data.stop.id && group.busId === fullOnlyBus.data.bus.id &&
      group.count === 1 && group.strandedCount === 1) &&
    demandOverview.unmetDemand.summary.some(group =>
      group.stopId === alternateStop.data.stop.id && group.busId === fullWithAltBus.data.bus.id &&
      group.count === 1 && group.hadAlternativeCount === 1))
  check('unmet-demand events also appear in the immutable audit trail',
    demandOverview.audit.filter(item => item.kind === 'unmet_demand').length >= 2)

  const demandByStop = new Map()
  for (const event of demandOverview.unmetDemand.events) {
    const item = demandByStop.get(event.stopId) || { stopName: event.stopName, count: 0, stranded: 0 }
    item.count += 1
    if (!event.hadAlternateBus) item.stranded += 1
    demandByStop.set(event.stopId, item)
  }
  const expectedTopDemandStop = [...demandByStop.values()]
    .sort((a, b) => b.count - a.count || b.stranded - a.stranded || a.stopName.localeCompare(b.stopName))[0]
  const beforeLocalDemandQuestion = JSON.stringify(getDb())
  const localDemandAnswer = await answerAdminQuestion('Which stop had the most unmet demand today?', {
    generator: async () => { throw new Error('External generator must not run for unmet demand queries') }
  })
  check('Admin assistant answers unmet-demand questions correctly through the local read-only query layer',
    localDemandAnswer.model === 'local-read-only' && localDemandAnswer.answer.includes(expectedTopDemandStop.stopName) &&
    localDemandAnswer.answer.includes(`${expectedTopDemandStop.count} rejected report`))
  check('local unmet-demand questions neither call a provider nor mutate data',
    JSON.stringify(getDb()) === beforeLocalDemandQuestion)
  const eveningDemandAnswer = await answerAdminQuestion('How many riders were unable to board on evening trips this week?', {
    generator: async () => { throw new Error('External generator must not run for direction-filtered unmet demand queries') }
  })
  check('local Admin assistant filters unmet demand by trip direction and date window',
    eveningDemandAnswer.model === 'local-read-only' && eveningDemandAnswer.answer.includes('evening trips'))

  console.log('UPDATE 1: confirmed downstream stops infer prior crossings without changing seat state')

  const inferredStopA = await call('/admin/stops', {
    method: 'POST', token: adminTok, body: { name: 'Inference Gate A', timeline: [], busIds: [] }
  })
  const inferredStopB = await call('/admin/stops', {
    method: 'POST', token: adminTok, body: { name: 'Inference Gate B', timeline: [], busIds: [] }
  })
  const inferredStopC = await call('/admin/stops', {
    method: 'POST', token: adminTok, body: { name: 'Inference Gate C', timeline: [], busIds: [] }
  })
  const inferenceBus = await call('/admin/buses', {
    method: 'POST', token: adminTok,
    body: {
      name: 'Inference Shuttle', capacity: 8,
      stopIds: [inferredStopA.data.stop.id, inferredStopB.data.stop.id, inferredStopC.data.stop.id]
    }
  })
  const inferredHoldRider = await createManagedUser(adminTok, {
      name: 'Inference Hold Rider', email: 'inference-hold@campus.edu', password: 'pass1234',
      role: 'rider', stopIds: [inferredStopB.data.stop.id]
  })
  const downstreamConfirmRider = await createManagedUser(adminTok, {
      name: 'Downstream Confirm Rider', email: 'inference-confirm@campus.edu', password: 'pass1234',
      role: 'rider', stopIds: [inferredStopC.data.stop.id]
  })
  await call('/rider/soft-hold', {
    method: 'POST', token: inferredHoldRider.data.token,
    body: { busId: inferenceBus.data.bus.id, response: 'yes' }
  })
  const inferenceEventStart = realtimeEvents.length
  const downstreamDetection = await call('/rider/ble/simulate', {
    method: 'POST', token: downstreamConfirmRider.data.token,
    body: { busId: inferenceBus.data.bus.id }
  })
  const downstreamConfirmation = await call(`/rider/prompts/${downstreamDetection.data.prompts[0].id}/respond`, {
    method: 'POST', token: downstreamConfirmRider.data.token, body: { response: 'yes' }
  })
  const inferenceOverview = (await call('/admin/overview', { token: adminTok })).data
  const inferenceBusView = inferenceOverview.occupancy.find(item => item.busId === inferenceBus.data.bus.id)
  const inferenceHoldReport = getDb().boardingReports.find(report =>
    report.userId === inferredHoldRider.data.user.id && report.busId === inferenceBus.data.bus.id &&
    report.tripDate === todayKey()
  )
  const inferredEvents = getDb().arrivalEvents.filter(event =>
    event.busId === inferenceBus.data.bus.id && event.tripDate === todayKey() && event.inferred
  )
  const inferredDemand = inferenceOverview.unmetDemand.events.find(event =>
    event.userId === inferredHoldRider.data.user.id && event.busId === inferenceBus.data.bus.id &&
    event.stopId === inferredStopB.data.stop.id && event.channel === 'inferred_stop_crossing'
  )
  check('a BLE confirmation at stop N atomically marks every earlier stop as crossed',
    downstreamConfirmation.status === 200 &&
    downstreamConfirmation.data.inferredStopIds.includes(inferredStopA.data.stop.id) &&
    downstreamConfirmation.data.inferredStopIds.includes(inferredStopB.data.stop.id) &&
    inferredEvents.length === 2)
  check('an inferred crossing does not promote or release an unresolved Soft Hold',
    inferenceHoldReport?.state === 'soft_hold' && inferenceBusView.softHolds === 1 &&
    inferenceBusView.seatsOccupied === 1)
  check('an unresolved hold at an inferred crossed stop becomes organized unmet demand',
    inferredDemand?.hadAlternateBus === false && inferredDemand?.channel === 'inferred_stop_crossing')
  check('crossing and occupancy changes refresh every connected client and the Admin audit',
    realtimeEvents.slice(inferenceEventStart).some(event => event.room === 'all' && event.event === 'refresh') &&
    inferenceOverview.audit.some(item =>
      item.kind === 'arrival_event' && item.outcome === 'inferred_crossed' &&
      item.detail.includes('Inference Gate B')))

  console.log('FEATURE: Android FCM device-token lifecycle and offline fallback')

  const fcmTokenA = 'fcm-test-token-a-12345678901234567890'
  const fcmTokenB = 'fcm-test-token-b-12345678901234567890'
  const tokenRegister = await call('/rider/device-tokens', {
    method: 'POST', token: rider, body: { fcmToken: fcmTokenA, platform: 'android' }
  })
  const registeredTokenId = tokenRegister.data.deviceToken.id
  check('post-login device token is registered for the authenticated rider',
    tokenRegister.status === 200 && tokenRegister.data.deviceToken.active === true &&
    getDb().deviceTokens.some(item => item.id === registeredTokenId && item.userId === login.data.user.id))

  const repeatedRegister = await call('/rider/device-tokens', {
    method: 'POST', token: rider, body: { fcmToken: fcmTokenA, platform: 'android' }
  })
  check('re-registering the same FCM token is idempotent',
    repeatedRegister.data.deviceToken.id === registeredTokenId &&
    getDb().deviceTokens.filter(item => item.userId === login.data.user.id).length === 1)

  const rotatedRegister = await call('/rider/device-tokens', {
    method: 'POST', token: rider,
    body: { fcmToken: fcmTokenB, previousToken: fcmTokenA, platform: 'android' }
  })
  check('FCM token rotation updates the existing row instead of duplicating it',
    rotatedRegister.data.deviceToken.id === registeredTokenId &&
    getDb().deviceTokens.filter(item => item.userId === login.data.user.id).length === 1 &&
    getDb().deviceTokens.find(item => item.id === registeredTokenId).fcmToken === fcmTokenB)

  const emittedDuringPushTests = []
  const socketIo = rooms => ({
    sockets: { adapter: { rooms } },
    emit(event, payload) { emittedDuringPushTests.push({ room: 'all', event, payload }) },
    to(room) {
      return { emit: (event, payload) => emittedDuringPushTests.push({ room, event, payload }) }
    }
  })
  let transportCalls = 0
  const successfulTransport = async message => {
    transportCalls++
    check('FCM payload is high-priority data-only delivery for the native action service',
      message.data.event_type === 'ble_confirmation_prompt' &&
      message.data.event_id === 'prompt-test-id' &&
      message.data.rider_id === login.data.user.id &&
      message.data.title === 'Test prompt' &&
      message.data.body === 'Are you boarding?' &&
      message.data.channel_id === 'seatline-prompts' &&
      message.data.native_actionable === 'true' &&
      message.android.priority === 'high' &&
      !message.notification && !message.android.notification)
    return { successCount: 1, failureCount: 0, responses: [{ success: true }] }
  }

  setIo(socketIo(new Map([[`user:${login.data.user.id}`, new Set(['socket-1'])]])))
  const connectedDelivery = await sendPushIfUserOffline({
    userId: login.data.user.id,
    title: 'Test prompt', body: 'Are you boarding?',
    data: { event_type: 'ble_confirmation_prompt', event_id: 'prompt-test-id', bus_id: bus1.busId, stop_id: bus1.stopIds[0] }
  }, { transport: successfulTransport })
  check('a socket-connected rider does not receive a redundant FCM push',
    connectedDelivery.skipped === 'socket_connected' && transportCalls === 0)

  setIo(socketIo(new Map()))
  const offlineDelivery = await sendPushIfUserOffline({
    userId: login.data.user.id,
    title: 'Test prompt', body: 'Are you boarding?',
    data: { event_type: 'ble_confirmation_prompt', event_id: 'prompt-test-id', bus_id: bus1.busId, stop_id: bus1.stopIds[0] }
  }, { transport: successfulTransport })
  check('an offline rider receives the FCM fallback once',
    offlineDelivery.sent === 1 && transportCalls === 1)

  let softHoldPushMessage = null
  const softHoldDelivery = await sendPushIfUserOffline({
    userId: login.data.user.id,
    title: 'Soft Hold test', body: 'Are you travelling?',
    data: { event_type: 'soft_hold_prompt', event_id: 'hold-test-id', bus_id: bus1.busId, stop_id: bus1.stopIds[0] }
  }, {
    transport: async message => {
      softHoldPushMessage = message
      return { successCount: 1, failureCount: 0, responses: [{ success: true }] }
    }
  })
  check('Soft Hold pushes are data-only, high priority and expose native Yes/No actions',
    softHoldDelivery.sent === 1 &&
    softHoldPushMessage?.data.event_type === 'soft_hold_prompt' &&
    softHoldPushMessage?.data.native_actionable === 'true' &&
    softHoldPushMessage?.android.priority === 'high' &&
    !softHoldPushMessage?.notification && !softHoldPushMessage?.android.notification)

  let informationalPushMessage = null
  await sendPushIfUserOffline({
    userId: login.data.user.id,
    title: 'Demand update', body: 'No seat is currently available.',
    data: { event_type: 'unmet_demand_alert', event_id: 'demand-test-id', bus_id: bus1.busId, stop_id: bus1.stopIds[0] }
  }, {
    transport: async message => {
      informationalPushMessage = message
      return { successCount: 1, failureCount: 0, responses: [{ success: true }] }
    }
  })
  check('non-actionable arrival/demand updates retain killed-app high-priority delivery',
    informationalPushMessage?.data.event_type === 'unmet_demand_alert' &&
    informationalPushMessage?.data.native_actionable === 'false' &&
    informationalPushMessage?.android.priority === 'high')

  await sendPushIfUserOffline({
    userId: login.data.user.id,
    title: 'Invalid token test', body: 'Test',
    data: { event_type: 'ble_confirmation_prompt', event_id: 'invalid-token-test' }
  }, {
    transport: async () => ({
      successCount: 0, failureCount: 1,
      responses: [{ success: false, error: { code: 'messaging/registration-token-not-registered' } }]
    })
  })
  check('FCM-invalid tokens are automatically retired',
    getDb().deviceTokens.find(item => item.id === registeredTokenId).active === false)

  await call('/rider/device-tokens', {
    method: 'POST', token: rider, body: { fcmToken: fcmTokenB, platform: 'android' }
  })
  const logoutToken = await call('/rider/device-tokens', {
    method: 'DELETE', token: rider, body: { fcmToken: fcmTokenB }
  })
  check('logout deactivates the current device token and stops future pushes',
    logoutToken.status === 200 && logoutToken.data.deactivated === true &&
    !getDb().deviceTokens.some(item => item.userId === login.data.user.id && item.active))
  const riderTokenWrite = await call('/rider/device-tokens', {
    method: 'POST', token: adminTok, body: { fcmToken: fcmTokenA, platform: 'android' }
  })
  check('Admins cannot register rider device tokens', riderTokenWrite.status === 403)

  console.log('CHANGE 4: admin-only read-only AI query assistant')

  const assistantSnapshot = adminReadSnapshot()
  check('assistant snapshot contains admin data but no credentials',
    assistantSnapshot.stops.length === getDb().stops.filter(item => item.active !== false).length &&
    !JSON.stringify(assistantSnapshot).includes('passwordHash'))
  let generatorInput = null
  const beforeReadQuestion = JSON.stringify(getDb())
  const assistantAnswer = await answerAdminQuestion('Which stops have no Incharge assigned?', {
    model: 'test/read-only-model',
    generator: async input => {
      generatorInput = input
      const json = input.prompt.split('Read-only data snapshot:\n')[1]
      const supplied = JSON.parse(json)
      const names = supplied.stops.filter(stop => stop.inchargeAssignments.length === 0).map(stop => stop.name)
      return { output: { resolved: true, answer: names.join(', ') } }
    }
  })
  check('assistant answers from the supplied read-only snapshot',
    assistantAnswer.answer.includes('Single Option Gate') && generatorInput && !('tools' in generatorInput))
  check('ordinary assistant questions cannot modify application data',
    JSON.stringify(getDb()) === beforeReadQuestion)
  const unresolvedAnswer = await answerAdminQuestion('What was the weather at each stop?', {
    model: 'test/read-only-model',
    generator: async () => ({ output: { resolved: false, answer: 'Weather data is not present in the Seatline snapshot.' } })
  })
  check('unresolvable questions return a clear non-fabricated fallback',
    unresolvedAnswer.unresolved === true && unresolvedAnswer.answer.includes('not present'))

  const riderAssistant = await call('/admin/assistant/query', {
    method: 'POST', token: rider, body: { question: 'Which buses are full?' }
  })
  const inchargeAssistant = await call('/admin/assistant/query', {
    method: 'POST', token: incharge, body: { question: 'Which buses are full?' }
  })
  check('assistant endpoint is unavailable to riders and Incharge-authority users',
    riderAssistant.status === 403 && inchargeAssistant.status === 403)

  const beforeWriteRequests = JSON.stringify(getDb())
  const writeRequests = await Promise.all([
    'Delete every stop',
    'Can you change Transfer-A capacity to 1?',
    'Please revoke all Incharge assignments',
    'I want you to adjust seats available to zero'
  ].map(question => call('/admin/assistant/query', {
    method: 'POST', token: adminTok, body: { question }
  })))
  check('write phrasing is refused before any provider call',
    writeRequests.every(result => result.status === 200 && result.data.refused === true))
  check('assistant write attempts leave all application data byte-for-byte unchanged',
    JSON.stringify(getDb()) === beforeWriteRequests)

  const priorGatewayKey = process.env.AI_GATEWAY_API_KEY
  delete process.env.AI_GATEWAY_API_KEY
  const unavailableAssistant = await call('/admin/assistant/query', {
    method: 'POST', token: adminTok, body: { question: 'How many buses are active?' }
  })
  if (priorGatewayKey) process.env.AI_GATEWAY_API_KEY = priorGatewayKey
  check('missing provider configuration produces a clear fallback, not fabrication',
    unavailableAssistant.status === 503 && unavailableAssistant.data.error.includes('not configured'))

  const scheduleOverview = await call('/admin/overview', { token: adminTok })
  check('Admin data surface exposes Trip direction/date and the Operating Calendar',
    scheduleOverview.status === 200 && scheduleOverview.data.trips.some(item => item.direction === 'morning') &&
    scheduleOverview.data.trips.some(item => item.direction === 'evening') &&
    Array.isArray(scheduleOverview.data.operatingCalendar.serviceWeekdays))
  const calendar = scheduleOverview.data.operatingCalendar
  const savedCalendar = await call('/admin/operating-calendar', {
    method: 'PUT', token: adminTok,
    body: { serviceWeekdays: calendar.serviceWeekdays, exceptions: calendar.exceptions }
  })
  check('Admin can save the weekly service pattern and date exceptions',
    savedCalendar.status === 200 && Array.isArray(savedCalendar.data.operatingCalendar.exceptions))
  const scheduleBus = scheduleOverview.data.buses[0]
  const savedTripTimes = await call(`/admin/buses/${scheduleBus.id}`, {
    method: 'PUT', token: adminTok,
    body: { morningStartTime: scheduleBus.morningStartTime, eveningStartTime: scheduleBus.eveningStartTime }
  })
  check('Admin can save Morning and Evening start times per bus',
    savedTripTimes.status === 200 && savedTripTimes.data.bus.morningStartTime === scheduleBus.morningStartTime &&
    savedTripTimes.data.bus.eveningStartTime === scheduleBus.eveningStartTime)

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
