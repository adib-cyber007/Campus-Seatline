const DEFAULT_CAMPUS_TIME_ZONE = 'Asia/Kolkata'

function validatedTimeZone(value) {
  const timeZone = String(value || DEFAULT_CAMPUS_TIME_ZONE).trim()
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(new Date(0))
    return timeZone
  } catch {
    throw new Error(`CAMPUS_TIME_ZONE must be a valid IANA timezone; received ${timeZone}`)
  }
}

export const CAMPUS_TIME_ZONE = validatedTimeZone(process.env.CAMPUS_TIME_ZONE)

const campusClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAMPUS_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23'
})

function asDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid instant: ${value}`)
  return date
}

export function campusDateTimeParts(value = new Date()) {
  return Object.fromEntries(campusClock.formatToParts(asDate(value))
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]))
}

export function campusDateKey(value = new Date()) {
  const { year, month, day } = campusDateTimeParts(value)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function campusMinutes(value = new Date()) {
  const { hour, minute } = campusDateTimeParts(value)
  return hour * 60 + minute
}

export function weekdayForDateKey(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey))) throw new Error(`Invalid date key: ${dateKey}`)
  return new Date(`${dateKey}T12:00:00.000Z`).getUTCDay() || 7
}
