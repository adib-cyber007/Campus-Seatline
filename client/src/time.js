export const DEFAULT_CAMPUS_TIME_ZONE = 'Asia/Kolkata'

const formatters = new Map()

function formatter(locale, timeZone, options) {
  const zone = timeZone || DEFAULT_CAMPUS_TIME_ZONE
  const key = JSON.stringify([locale || '', zone, options])
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }))
  }
  return formatters.get(key)
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function campusDateKey(value = new Date(), timeZone = DEFAULT_CAMPUS_TIME_ZONE) {
  const date = validDate(value)
  if (!date) return ''
  const parts = Object.fromEntries(formatter('en-CA', timeZone, {
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function campusHour(value = new Date(), timeZone = DEFAULT_CAMPUS_TIME_ZONE) {
  const date = validDate(value)
  if (!date) return 0
  const hour = formatter('en', timeZone, { hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).find(part => part.type === 'hour')?.value
  return Number(hour || 0)
}

export function formatCampusDate(value, timeZone, options = {}) {
  const date = validDate(value)
  return date ? formatter(undefined, timeZone, {
    weekday: 'long', month: 'short', day: 'numeric', ...options
  }).format(date) : '—'
}

export function formatCampusTime(value, timeZone, options = {}) {
  const date = validDate(value)
  return date ? formatter(undefined, timeZone, {
    hour: '2-digit', minute: '2-digit', ...options
  }).format(date) : '—'
}

export function formatCampusDateTime(value, timeZone, options = {}) {
  const date = validDate(value)
  return date ? formatter(undefined, timeZone, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...options
  }).format(date) : '—'
}
