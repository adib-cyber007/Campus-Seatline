import { getDb, nextId, resetDatabase, runDatabaseTransaction } from './src/db.js'
import {
  countsForTrip,
  generateTripsForDate,
  reconcileTripSchedule
} from './src/services/trips.js'

if (process.env.SEATLINE_TEST_SCHEMA !== 'seatline_test') {
  throw new Error('Refusing to reset a non-test database. Run this test through npm run smoke:trips.')
}

let passed = 0
let failed = 0
function check(name, condition, extra = '') {
  if (condition) {
    passed++
    console.log(`  ok - ${name}`)
  } else {
    failed++
    console.error(`  FAIL - ${name} ${extra}`)
  }
}

await resetDatabase()
await runDatabaseTransaction(() => {
  const db = getDb()
  db.operatingCalendar.serviceWeekdays = [1, 2, 3, 4, 5, 6, 7]
  for (const bus of db.buses) {
    bus.morningStartTime = '07:00'
    bus.eveningStartTime = '17:00'
  }

  console.log('TRIPS 1: service generation and stop policy')
  const beforeStart = reconcileTripSchedule(new Date(2030, 0, 7, 6, 0))
  check('service day creates morning and evening trips for every active bus',
    beforeStart.generated.length === db.buses.length * 2)
  check('trips remain scheduled before the configured morning time',
    db.trips.every(trip => trip.status === 'scheduled'))
  for (const bus of db.buses) {
    const morning = db.trips.find(trip => trip.busId === bus.id && trip.direction === 'morning')
    const evening = db.trips.find(trip => trip.busId === bus.id && trip.direction === 'evening')
    check(`${bus.name} morning preserves the existing stop sequence and boards at every stop`,
      JSON.stringify(morning.stopSequence) === JSON.stringify(bus.stopIds) &&
      JSON.stringify(morning.boardingStopSet) === JSON.stringify(bus.stopIds))
    check(`${bus.name} evening reverses the morning sequence and boards only at its campus terminal`,
      JSON.stringify(evening.stopSequence) === JSON.stringify([...bus.stopIds].reverse()) &&
      evening.boardingStopSet.length === 1 && evening.boardingStopSet[0] === bus.stopIds.at(-1))
  }

  console.log('TRIPS 2: pure-clock activation and atomic force-close')
  const morningActivation = reconcileTripSchedule(new Date(2030, 0, 7, 8, 0))
  check('morning activates from the clock without a final-stop prerequisite',
    morningActivation.activated.length === db.buses.length &&
    morningActivation.activated.every(trip => trip.direction === 'morning'))
  check('each bus has exactly one active trip after morning activation',
    db.buses.every(bus => db.trips.filter(trip => trip.busId === bus.id && trip.status === 'active').length === 1))

  const bus = db.buses[0]
  const morning = db.trips.find(trip => trip.busId === bus.id && trip.direction === 'morning')
  const [holdRider, occupiedRider] = db.users.filter(user => user.role === 'rider').slice(0, 2)
  const now = new Date(2030, 0, 7, 8, 1).toISOString()
  db.boardingReports.push(
    {
      id: nextId(), userId: holdRider.id, tripId: morning.id, busId: bus.id,
      stopId: morning.boardingStopSet[0], alightStopId: null, tripDate: morning.date,
      tripDirection: morning.direction, state: 'soft_hold', source: 'test', createdAt: now, updatedAt: now
    },
    {
      id: nextId(), userId: occupiedRider.id, tripId: morning.id, busId: bus.id,
      stopId: morning.boardingStopSet[1] || morning.boardingStopSet[0], alightStopId: null,
      tripDate: morning.date, tripDirection: morning.direction, state: 'seats_occupied',
      source: 'test', createdAt: now, updatedAt: now
    }
  )
  db.tripOccupancy[morning.id].manualAdjustment = 2
  db.prompts.push({
    id: nextId(), userId: holdRider.id, tripId: morning.id, busId: bus.id,
    stopId: morning.boardingStopSet[0], kind: 'ble_confirm', detectionSource: 'test',
    beacon: null, status: 'pending', tripDate: morning.date, tripDirection: morning.direction,
    createdAt: now, expiresAt: new Date(2030, 0, 7, 9, 0).toISOString()
  })

  const eveningActivation = reconcileTripSchedule(new Date(2030, 0, 7, 18, 0))
  const evening = db.trips.find(trip => trip.busId === bus.id && trip.direction === 'evening')
  const closure = db.tripClosures.find(item => item.tripId === morning.id)
  check('evening activation force-closes morning in the same reconciliation',
    eveningActivation.closed.some(item => item.tripId === morning.id) &&
    morning.status === 'completed' && morning.completionReason === 'force_closed' &&
    evening.status === 'active')
  check('force-close snapshot preserves final occupied, adjustment, and hold counts',
    closure.finalBaseOccupied === 1 && closure.finalManualAdjustment === 2 &&
    closure.finalSeatsOccupied === 3 && closure.finalSoftHolds === 1 && closure.unresolvedSoftHolds === 1)
  check('force-close releases active rider states and cancels pending prompts',
    db.boardingReports.filter(report => report.tripId === morning.id).every(report => report.state === 'released') &&
    db.prompts.find(prompt => prompt.tripId === morning.id).status === 'cancelled')
  check('unresolved hold is retained as trip-scoped unmet demand',
    db.unmetDemandEvents.some(event => event.tripId === morning.id &&
      event.tripDirection === 'morning' && event.channel === 'force_close_unresolved_hold'))
  check('new trip begins with no carryover and one active trip per bus',
    countsForTrip(evening).seatsOccupied === 0 && countsForTrip(evening).softHolds === 0 &&
    db.trips.filter(trip => trip.busId === bus.id && trip.status === 'active').length === 1)

  console.log('TRIPS 3: operating-calendar exceptions')
  db.operatingCalendar.exceptions.push({ date: '2030-01-08', service: false, note: 'Holiday' })
  const forcedOff = generateTripsForDate('2030-01-08')
  check('forced-off exception creates no trips', forcedOff.length === 0 &&
    !db.trips.some(trip => trip.date === '2030-01-08'))
  db.operatingCalendar.serviceWeekdays = []
  db.operatingCalendar.exceptions.push({ date: '2030-01-09', service: true, note: 'Makeup day' })
  const forcedOn = generateTripsForDate('2030-01-09')
  check('forced-on exception creates both directions for every active bus',
    forcedOn.length === db.buses.length * 2)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
