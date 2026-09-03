process.env.TZ = 'UTC'

const {
  campusDateKey, campusHour, formatCampusDate, formatCampusDateTime, formatCampusTime
} = await import('../src/time.js')

const instant = '2030-01-06T18:31:00.000Z'
const zone = 'Asia/Kolkata'
const checks = [
  ['UTC instant renders on the next campus date', campusDateKey(instant, zone) === '2030-01-07'],
  ['campus greeting hour is independent of device timezone', campusHour(instant, zone) === 0],
  ['campus date formatter renders the campus day', /7/.test(formatCampusDate(instant, zone))],
  ['campus time formatter renders a value', formatCampusTime(instant, zone) !== '—'],
  ['campus date-time formatter renders a value', formatCampusDateTime(instant, zone) !== '—']
]

let failed = 0
for (const [label, condition] of checks) {
  if (condition) console.log(`  ok - ${label}`)
  else { failed++; console.error(`  FAIL - ${label}`) }
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
