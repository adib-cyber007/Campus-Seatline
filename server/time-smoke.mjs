process.env.TZ = 'UTC'
process.env.CAMPUS_TIME_ZONE = 'Asia/Kolkata'

const { closeDatabase, getDb, resetDatabase, runDatabaseTransaction } = await import('./src/db.js')
const { pool } = await import('./src/database/client.js')
const { CAMPUS_TIME_ZONE, campusDateKey, campusMinutes } = await import('./src/time.js')
const { reconcileTripSchedule } = await import('./src/services/trips.js')

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ok - ${name}`)
  } else {
    failed++
    console.error(`  FAIL - ${name}${detail ? `: ${detail}` : ''}`)
  }
}

console.log('Time accuracy: UTC host, Asia/Kolkata campus clock')

try {
  await resetDatabase()
  const zone = await pool.query('SHOW TIMEZONE')
  check('PostgreSQL sessions are fixed to UTC', zone.rows[0]?.TimeZone === 'UTC', JSON.stringify(zone.rows[0]))
  check('configured IANA campus timezone is authoritative', CAMPUS_TIME_ZONE === 'Asia/Kolkata')

  const justAfterCampusMidnight = new Date('2030-01-06T18:31:00.000Z')
  check('campus service date crosses midnight independently of the UTC host date',
    campusDateKey(justAfterCampusMidnight) === '2030-01-07')
  check('campus wall-clock minutes are derived from the configured zone',
    campusMinutes(justAfterCampusMidnight) === 1)

  await runDatabaseTransaction(() => {
    const db = getDb()
    db.operatingCalendar.serviceWeekdays = [1, 2, 3, 4, 5, 6, 7]
    for (const bus of db.buses) {
      bus.morningStartTime = '07:00'
      bus.eveningStartTime = '17:00'
    }

    const generated = reconcileTripSchedule(justAfterCampusMidnight)
    check('the campus date generates both trips while the UTC host is still on the prior date',
      generated.generated.length === db.buses.length * 2 &&
      generated.generated.every(trip => trip.date === '2030-01-07'))

    const beforeMorning = reconcileTripSchedule(new Date('2030-01-07T01:29:59.000Z'))
    check('Morning remains scheduled one second before 07:00 campus time',
      beforeMorning.activated.length === 0 && db.trips.every(trip => trip.status === 'scheduled'))

    const atMorning = reconcileTripSchedule(new Date('2030-01-07T01:30:00.000Z'))
    check('Morning activates exactly at 07:00 campus time on a UTC host',
      atMorning.activated.length === db.buses.length &&
      atMorning.activated.every(trip => trip.direction === 'morning' && trip.activatedAt === '2030-01-07T01:30:00.000Z'))

    const beforeEvening = reconcileTripSchedule(new Date('2030-01-07T11:29:59.000Z'))
    check('Morning stays active one second before 17:00 campus time',
      beforeEvening.activated.length === 0 && beforeEvening.closed.length === 0 &&
      db.buses.every(bus => db.trips.some(trip => trip.busId === bus.id && trip.status === 'active' && trip.direction === 'morning')))

    const atEvening = reconcileTripSchedule(new Date('2030-01-07T11:30:00.000Z'))
    check('Evening activates and force-closes Morning exactly at 17:00 campus time',
      atEvening.activated.length === db.buses.length && atEvening.closed.length === db.buses.length &&
      db.buses.every(bus => db.trips.filter(trip => trip.busId === bus.id && trip.status === 'active').length === 1) &&
      atEvening.activated.every(trip => trip.direction === 'evening' && trip.activatedAt === '2030-01-07T11:30:00.000Z') &&
      atEvening.closed.every(closure => closure.timestamp === '2030-01-07T11:30:00.000Z'))
  })
} finally {
  await closeDatabase()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
