import crypto from 'node:crypto'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { closeDatabase, resetDatabase, todayKey } from './src/db.js'

if (process.env.SEATLINE_TEST_SCHEMA !== 'seatline_test') {
  throw new Error('Refusing to reset a non-test database. Run through npm run verify:postgres.')
}

const serverRoot = dirname(fileURLToPath(import.meta.url))
const { Pool } = pg
let child = null
let pool = null
let base = ''

function check(label, condition, detail = '') {
  if (!condition) throw new Error(label + (detail ? ': ' + detail : ''))
  console.log('  ok - ' + label)
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(error => error ? reject(error) : resolve(port))
    })
  })
}

async function startServer(port) {
  const processHandle = spawn(process.execPath, ['src/index.js'], {
    cwd: serverRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  processHandle.stdout.on('data', chunk => { output += chunk.toString() })
  processHandle.stderr.on('data', chunk => { output += chunk.toString() })
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timed out. Output: ' + output)), 12_000)
    const poll = setInterval(() => {
      if (output.includes('API + WebSocket listening')) {
        clearTimeout(timeout)
        clearInterval(poll)
        resolve()
      }
    }, 25)
    processHandle.once('exit', code => {
      clearTimeout(timeout)
      clearInterval(poll)
      reject(new Error('Server exited during startup (' + code + '). Output: ' + output))
    })
  })
  return processHandle
}

async function stopServer(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return
  const exited = new Promise(resolve => processHandle.once('exit', resolve))
  processHandle.kill('SIGTERM')
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Server did not stop')), 8_000))
  ])
}

async function call(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = 'Bearer ' + token
  const response = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  })
  const data = await response.json().catch(() => ({}))
  return { status: response.status, data }
}

async function requireCall(path, options, status = 200) {
  const response = await call(path, options)
  check((options?.method || 'GET') + ' ' + path + ' returned ' + status,
    response.status === status,
    'got ' + response.status + ' ' + JSON.stringify(response.data))
  return response.data
}

async function provisionUser(adminToken, body) {
  const created = await requireCall('/admin/users', {
    method: 'POST', token: adminToken, body
  }, 201)
  const login = await requireCall('/auth/login', {
    method: 'POST', body: { email: body.email, password: body.password }
  })
  return { user: created.user, token: login.token }
}

async function databaseFingerprint() {
  const tables = [
    'users', 'stops', 'buses', 'bus_beacons', 'user_stops', 'bus_stops', 'incharge_assignments',
    'boarding_reports', 'occupancy_adjustments', 'ble_prompts', 'arrival_events',
    'arrival_event_confirmations', 'report_attempts', 'unmet_demand_events', 'incharge_overrides',
    'audit_records', 'daily_stop_overrides', 'notifications', 'fcm_device_tokens'
  ]
  const result = {}
  for (const table of tables) {
    result[table] = Number((await pool.query('SELECT count(*) AS count FROM ' + table)).rows[0].count)
  }
  return result
}

async function main() {
  console.log('Phase 1 PostgreSQL restart, constraint and concurrency verification')
  await resetDatabase()
  await closeDatabase()

  pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const port = await freePort()
  base = 'http://127.0.0.1:' + port + '/api'
  child = await startServer(port)

  const admin = await requireCall('/auth/login', {
    method: 'POST', body: { email: 'admin@campus.edu', password: 'admin123' }
  })
  const stopA = (await requireCall('/admin/stops', {
    method: 'POST', token: admin.token,
    body: { name: 'Persistence Gate A', timeline: [{ time: '07:45', label: 'Morning trip' }], busIds: [] }
  }, 201)).stop
  const stopB = (await requireCall('/admin/stops', {
    method: 'POST', token: admin.token,
    body: { name: 'Persistence Gate B', timeline: [{ time: '08:00', label: 'Morning trip' }], busIds: [] }
  }, 201)).stop
  const busA = (await requireCall('/admin/buses', {
    method: 'POST', token: admin.token,
    body: { name: 'Persistence Bus A', capacity: 12, stopIds: [stopA.id, stopB.id] }
  }, 201)).bus
  const busB = (await requireCall('/admin/buses', {
    method: 'POST', token: admin.token,
    body: { name: 'Persistence Bus B', capacity: 12, stopIds: [stopA.id, stopB.id] }
  }, 201)).bus

  const riderOne = await provisionUser(admin.token, {
      name: 'Restart Rider One', email: 'restart-one@campus.edu',
      password: 'pass1234', role: 'rider', stopIds: [stopA.id]
  })
  const riderTwo = await provisionUser(admin.token, {
      name: 'Restart Rider Two', email: 'restart-two@campus.edu',
      password: 'pass1234', role: 'rider', stopIds: [stopA.id]
  })
  const riderThree = await provisionUser(admin.token, {
      name: 'Constraint Rider', email: 'constraint@campus.edu',
      password: 'pass1234', role: 'rider', stopIds: [stopA.id]
  })

  const assignment = (await requireCall('/admin/incharge-assignments', {
    method: 'POST', token: admin.token,
    body: { riderId: riderOne.user.id, scopeType: 'bus', busId: busA.id }
  }, 201)).assignment

  await requireCall('/rider/soft-hold', {
    method: 'POST', token: riderOne.token, body: { busId: busA.id, response: 'yes' }
  })
  const boardingPrompt = (await requireCall('/rider/ble/simulate', {
    method: 'POST', token: riderOne.token, body: { busId: busB.id }
  })).prompts[0]
  const boarded = await requireCall('/rider/prompts/' + boardingPrompt.id + '/respond', {
    method: 'POST', token: riderOne.token, body: { response: 'yes' }
  })
  check('pre-restart BLE switch releases Bus A and occupies Bus B directly',
    boarded.transferredFromBusId === busA.id && boarded.promoted === false)

  await requireCall('/rider/incharge/buses/' + busA.id + '/available', {
    method: 'POST', token: riderOne.token, body: { seatsAvailable: 11 }
  })
  await requireCall('/rider/daily-stop', {
    method: 'POST', token: riderOne.token, body: { stopId: stopB.id }
  })
  await requireCall('/rider/device-tokens', {
    method: 'POST', token: riderOne.token,
    body: { fcmToken: 'restart-proof-token-12345678901234567890', platform: 'android' }
  })

  await requireCall('/rider/soft-hold', {
    method: 'POST', token: riderTwo.token, body: { busId: busA.id, response: 'yes' }
  })
  const pendingPrompt = (await requireCall('/rider/ble/simulate', {
    method: 'POST', token: riderTwo.token, body: { busId: busB.id }
  })).prompts[0]
  await requireCall('/rider/incharge/buses/' + busA.id + '/available', {
    method: 'POST', token: riderOne.token, body: { seatsAvailable: 0 }
  })
  const capacityReject = await call('/rider/soft-hold', {
    method: 'POST', token: riderThree.token, body: { busId: busA.id, response: 'yes' }
  })
  check('pre-restart capacity rejection creates unmet demand',
    capacityReject.status === 409 && capacityReject.data.error.includes('no seats available'))

  const archivedStop = (await requireCall('/admin/stops', {
    method: 'POST', token: admin.token,
    body: { name: 'Archived Persistence Gate', timeline: [], busIds: [] }
  }, 201)).stop
  const archivedBus = (await requireCall('/admin/buses', {
    method: 'POST', token: admin.token,
    body: { name: 'Archived Persistence Bus', capacity: 8, stopIds: [archivedStop.id] }
  }, 201)).bus
  await requireCall('/admin/buses/' + archivedBus.id, { method: 'DELETE', token: admin.token })
  await requireCall('/admin/stops/' + archivedStop.id, { method: 'DELETE', token: admin.token })

  const beforeAdmin = await requireCall('/admin/overview', { token: admin.token })
  const beforeRiderOne = await requireCall('/rider/overview', { token: riderOne.token })
  const beforeRiderTwo = await requireCall('/rider/overview', { token: riderTwo.token })
  const beforeCounts = await databaseFingerprint()
  check('dedicated audit_records table is populated',
    beforeCounts.audit_records > 0 && beforeCounts.audit_records === beforeAdmin.audit.length)

  await stopServer(child)
  child = null
  console.log('  server stopped; starting a fresh Node.js process')
  child = await startServer(port)

  const adminAfterLogin = await requireCall('/auth/login', {
    method: 'POST', body: { email: 'admin@campus.edu', password: 'admin123' }
  })
  const riderOneAfterLogin = await requireCall('/auth/login', {
    method: 'POST', body: { email: 'restart-one@campus.edu', password: 'pass1234' }
  })
  const riderTwoAfterLogin = await requireCall('/auth/login', {
    method: 'POST', body: { email: 'restart-two@campus.edu', password: 'pass1234' }
  })
  const afterAdmin = await requireCall('/admin/overview', { token: adminAfterLogin.token })
  const afterRiderOne = await requireCall('/rider/overview', { token: riderOneAfterLogin.token })
  const afterRiderTwo = await requireCall('/rider/overview', { token: riderTwoAfterLogin.token })
  const afterCounts = await databaseFingerprint()

  check('all required table row counts survive process restart',
    JSON.stringify(afterCounts) === JSON.stringify(beforeCounts),
    JSON.stringify({ beforeCounts, afterCounts }))
  check('created stops and buses survive process restart',
    afterAdmin.stops.some(item => item.id === stopA.id) &&
    afterAdmin.stops.some(item => item.id === stopB.id) &&
    afterAdmin.buses.some(item => item.id === busA.id) &&
    afterAdmin.buses.some(item => item.id === busB.id))
  check('unique bus beacon mappings survive process restart unchanged',
    afterAdmin.buses.find(item => item.id === busA.id).beacon.serviceUuid ===
      beforeAdmin.buses.find(item => item.id === busA.id).beacon.serviceUuid &&
    afterAdmin.buses.find(item => item.id === busB.id).beacon.serviceUuid ===
      beforeAdmin.buses.find(item => item.id === busB.id).beacon.serviceUuid &&
    afterAdmin.buses.find(item => item.id === busA.id).beacon.serviceUuid !==
      afterAdmin.buses.find(item => item.id === busB.id).beacon.serviceUuid)
  check('Incharge authority survives process restart',
    afterAdmin.assignments.some(item => item.id === assignment.id && !item.revokedAt))
  check('occupied report and derived occupancy survive process restart',
    afterRiderOne.boardedBusIds.includes(busB.id) &&
    afterRiderOne.buses.find(item => item.busId === busB.id).seatsOccupied ===
      beforeRiderOne.buses.find(item => item.busId === busB.id).seatsOccupied)
  check('Seats Available override survives with Occupied still derived',
    afterRiderOne.buses.find(item => item.busId === busA.id).availableSeats ===
      beforeRiderOne.buses.find(item => item.busId === busA.id).availableSeats)
  check('daily stop override survives restart without changing default stop',
    afterRiderOne.dailyStopOverride?.stopId === stopB.id &&
    afterRiderOne.defaultStops[0].id === stopA.id)
  check('active Soft Hold and pending BLE prompt survive restart',
    afterRiderTwo.softHoldBusIds.includes(busA.id) &&
    afterRiderTwo.prompts.some(item => item.id === pendingPrompt.id) &&
    beforeRiderTwo.prompts.some(item => item.id === pendingPrompt.id))
  check('audit log survives restart unchanged',
    JSON.stringify(afterAdmin.audit) === JSON.stringify(beforeAdmin.audit))
  check('unmet-demand rows and classifications survive process restart',
    afterCounts.unmet_demand_events > 0 &&
    afterAdmin.unmetDemand.events.some(item =>
      item.userId === riderThree.user.id && item.busId === busA.id && item.hadAlternateBus === true))
  const archivedRows = await pool.query(
    'SELECT id, active FROM buses WHERE id = $1 UNION ALL SELECT id, active FROM stops WHERE id = $2',
    [archivedBus.id, archivedStop.id]
  )
  check('archived Bus and Stop flags survive restart while active views hide them',
    archivedRows.rows.length === 2 && archivedRows.rows.every(item => item.active === false) &&
    !afterAdmin.buses.some(item => item.id === archivedBus.id) &&
    !afterAdmin.stops.some(item => item.id === archivedStop.id))
  check('archive audit records survive restart with historical entity names',
    afterAdmin.audit.some(item => item.kind === 'entity_archived' && item.detail.includes('Archived Persistence Bus')) &&
    afterAdmin.audit.some(item => item.kind === 'entity_archived' && item.detail.includes('Archived Persistence Gate')))

  const rapid = await Promise.all(Array.from({ length: 12 }, () =>
    call('/rider/prompts/' + pendingPrompt.id + '/respond', {
      method: 'POST', token: riderTwoAfterLogin.token, body: { response: 'yes' }
    })
  ))
  check('post-restart simultaneous BLE responses accept exactly one',
    rapid.filter(item => item.status === 200).length === 1 &&
    rapid.filter(item => item.status === 409).length === 11)
  const postRace = await requireCall('/rider/overview', { token: riderTwoAfterLogin.token })
  check('post-restart transfer is atomic and cannot inflate counts',
    !postRace.softHoldBusIds.includes(busA.id) &&
    postRace.boardedBusIds.includes(busB.id) &&
    postRace.buses.find(item => item.busId === busA.id).softHolds === 0)

  let uniqueViolation = null
  await pool.query('BEGIN')
  try {
    const values = [
      crypto.randomUUID(), riderThree.user.id, busA.id, stopA.id, todayKey(),
      'soft_hold', 'constraint_probe', new Date().toISOString(), new Date().toISOString()
    ]
    await pool.query(
      'INSERT INTO boarding_reports (id,user_id,bus_id,stop_id,trip_date,state,source,created_at,updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', values
    )
    values[0] = crypto.randomUUID()
    values[2] = busB.id
    values[5] = 'seats_occupied'
    await pool.query(
      'INSERT INTO boarding_reports (id,user_id,bus_id,stop_id,trip_date,state,source,created_at,updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', values
    )
  } catch (error) {
    uniqueViolation = error
  } finally {
    await pool.query('ROLLBACK')
  }
  check('database rejects two active reports for one rider/trip',
    uniqueViolation?.code === '23505' &&
    uniqueViolation.constraint === 'boarding_reports_one_active_per_rider_trip')

  const index = await pool.query(
    "SELECT indexdef FROM pg_indexes WHERE indexname = 'boarding_reports_one_active_per_rider_trip'"
  )
  check('active-report rule is a PostgreSQL partial unique index',
    index.rows[0]?.indexdef.includes('UNIQUE') &&
    index.rows[0]?.indexdef.includes('soft_hold') &&
    index.rows[0]?.indexdef.includes('seats_occupied'))

  console.log('\nPhase 1 PostgreSQL verification passed.')
}

try {
  await main()
} finally {
  await stopServer(child).catch(() => {})
  if (pool) await pool.end().catch(() => {})
}
