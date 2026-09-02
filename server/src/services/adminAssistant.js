import { generateText, Output } from 'ai'
import { z } from 'zod'
import { getDb, busById, stopById, todayKey, userById } from '../db.js'
import { auditSnapshot } from './audit.js'
import { enrichedUnmetDemandEvents } from './unmetDemand.js'
import { activeTripForBus, countsForTrip } from './trips.js'

const DEFAULT_MODEL = 'openai/gpt-5.4-mini'
const WRITE_VERBS = '(?:create|add|delete|remove|edit|update|change|set|assign|reassign|revoke|grant|modify|write|adjust)'
const WRITE_REQUEST = new RegExp(
  `(?:^\\s*(?:please\\s+)?${WRITE_VERBS}\\b)|(?:\\b(?:can|could|would|will)\\s+you\\s+${WRITE_VERBS}\\b)|(?:\\bi\\s+want\\s+you\\s+to\\s+${WRITE_VERBS}\\b)`,
  'i'
)
const answerSchema = z.object({
  resolved: z.boolean().describe('True only when the supplied snapshot contains enough evidence to answer.'),
  answer: z.string().max(8000).describe('A concise grounded answer, or a clear explanation of what data is missing.')
})

function localUnmetDemandAnswer(question) {
  const clean = String(question || '').toLowerCase()
  const isDemandQuestion = /unmet demand|insufficient seats?|unable to (?:get|find|board)|could not (?:get|find|board)|couldn't (?:get|find|board)|stranded|no alternate/.test(clean)
  if (!isDemandQuestion) return null
  const direction = /\bevening\b/.test(clean) ? 'evening' : /\bmorning\b/.test(clean) ? 'morning' : null

  const now = new Date()
  let periodLabel = 'in the recorded history'
  let since = null
  if (/\btoday\b/.test(clean)) {
    periodLabel = 'today'
    since = todayKey()
  } else if (/\b(?:this|past|last) week\b/.test(clean)) {
    periodLabel = 'in the last 7 days'
    since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  }

  const events = enrichedUnmetDemandEvents().filter(event =>
    (!direction || event.tripDirection === direction) &&
    (!since || (since.length === 10 ? event.tripDate === since : String(event.timestamp) >= since))
  )
  const directionLabel = direction ? ` on ${direction} trips` : ''
  if (events.length === 0) {
    return {
      answer: `No insufficient-seat events were recorded ${periodLabel}${directionLabel}.`,
      refused: false, unresolved: false, model: 'local-read-only', generatedAt: now.toISOString()
    }
  }

  const byStop = new Map()
  for (const event of events) {
    const item = byStop.get(event.stopId) || { stopName: event.stopName, count: 0, stranded: 0 }
    item.count += 1
    if (!event.hadAlternateBus) item.stranded += 1
    byStop.set(event.stopId, item)
  }
  const stops = [...byStop.values()].sort((a, b) => b.count - a.count || b.stranded - a.stranded || a.stopName.localeCompare(b.stopName))
  if (/which stop|most|highest|top/.test(clean)) {
    const top = stops[0]
    return {
      answer: `${top.stopName} had the most unmet demand ${periodLabel}${directionLabel}: ${top.count} rejected report${top.count === 1 ? '' : 's'}, including ${top.stranded} stranded rider${top.stranded === 1 ? '' : 's'}.`,
      refused: false, unresolved: false, model: 'local-read-only', generatedAt: now.toISOString()
    }
  }

  const stranded = events.filter(event => !event.hadAlternateBus).length
  const lines = stops.slice(0, 8).map(item =>
    `- ${item.stopName}: ${item.count} event${item.count === 1 ? '' : 's'} · ${item.stranded} stranded`
  )
  return {
    answer: `${events.length} insufficient-seat event${events.length === 1 ? ' was' : 's were'} recorded ${periodLabel}${directionLabel}; ${stranded} left the rider without an alternate bus.\n${lines.join('\n')}`,
    refused: false, unresolved: false, model: 'local-read-only', generatedAt: now.toISOString()
  }
}
export function isWriteRequest(question) {
  return WRITE_REQUEST.test(String(question || ''))
}

export function adminReadSnapshot() {
  const db = getDb()
  const tripDate = todayKey()
  const activeAssignments = db.inchargeAssignments.filter(item => !item.revokedAt)
  const occupancy = db.buses.filter(bus => bus.active !== false).map(bus => {
    const trip = activeTripForBus(bus.id)
    const counts = trip ? countsForTrip(trip) : { seatsOccupied: 0, softHolds: 0, availableSeats: 0 }
    return {
      busId: bus.id,
      seatsOccupied: counts.seatsOccupied,
      softHolds: counts.softHolds,
      availableSeats: counts.availableSeats
    }
  })

  const value = {
    tripDate,
    generatedAt: new Date().toISOString(),
    stops: db.stops.filter(stop => stop.active !== false).map(stop => ({
      id: stop.id,
      name: stop.name,
      timeline: stop.timeline,
      buses: stop.busIds.filter(busId => busById(busId)).map(busId => busById(busId).name),
      inchargeAssignments: activeAssignments
        .filter(item => (item.scopeType === 'stop' && item.stopId === stop.id) ||
          (item.scopeType === 'bus' && stop.busIds.includes(item.busId)))
        .map(item => userById(item.riderId)?.name || item.riderId)
    })),
    buses: db.buses.filter(bus => bus.active !== false).map(bus => {
      const counts = occupancy.find(item => item.busId === bus.id)
      return {
        id: bus.id,
        name: bus.name,
        capacity: bus.capacity,
        stops: bus.stopIds.filter(stopId => stopById(stopId)).map(stopId => stopById(stopId).name),
        seatsOccupied: counts?.seatsOccupied || 0,
        seatsAvailable: counts?.availableSeats || 0,
        softHolds: counts?.softHolds || 0,
        occupancyPercent: bus.capacity ? Math.round(((counts?.seatsOccupied || 0) / bus.capacity) * 1000) / 10 : 0,
        inchargeAssignments: activeAssignments
          .filter(item => (item.scopeType === 'bus' && item.busId === bus.id) ||
            (item.scopeType === 'stop' && bus.stopIds.includes(item.stopId)))
          .map(item => userById(item.riderId)?.name || item.riderId)
      }
    }),
    inchargeAssignments: db.inchargeAssignments.map(item => ({
      id: item.id,
      rider: userById(item.riderId)?.name || item.riderId,
      scopeType: item.scopeType,
      scope: item.scopeType === 'bus'
        ? (busById(item.busId)?.name || item.busId)
        : (stopById(item.stopId)?.name || item.stopId),
      grantedAt: item.grantedAt,
      revokedAt: item.revokedAt || null
    })),
    audit: auditSnapshot().map(item => ({
      kind: item.kind,
      timestamp: item.timestamp,
      actor: item.actor,
      outcome: item.outcome || null,
      detail: item.detail
    }))
  }

  return JSON.parse(JSON.stringify(value))
}

export async function answerAdminQuestion(question, { generator = generateText, model } = {}) {
  const cleanQuestion = String(question || '').trim()
  if (!cleanQuestion) {
    const error = new Error('Enter a question about stops, buses, occupancy, Incharge assignments, unmet demand, or the audit log.')
    error.status = 400
    throw error
  }
  if (cleanQuestion.length > 500) {
    const error = new Error('Keep the question under 500 characters.')
    error.status = 400
    throw error
  }
  if (isWriteRequest(cleanQuestion)) {
    return {
      answer: 'This assistant is read-only. It can explain current transport data, but it cannot create, edit, assign, revoke, or adjust anything.',
      refused: true,
      model: null
    }
  }
  const localDemandAnswer = localUnmetDemandAnswer(cleanQuestion)
  if (localDemandAnswer) return localDemandAnswer
  if (generator === generateText && !process.env.AI_GATEWAY_API_KEY) {
    const error = new Error('The Admin AI assistant is not configured yet. Set AI_GATEWAY_API_KEY on the server and try again.')
    error.status = 503
    throw error
  }

  const readSnapshot = adminReadSnapshot()
  const selectedModel = model || process.env.ADMIN_AI_MODEL || DEFAULT_MODEL
  const result = await generator({
    model: selectedModel,
    system: [
      'You are the read-only reporting assistant for Campus Seatline transport admins.',
      'Answer only from the supplied JSON snapshot. Never claim that you changed data.',
      'Set resolved=false if the snapshot does not contain enough evidence.',
      'Be concise. For multiple results, use a short Markdown list or table.',
      'Soft Holds represent travel intent only; never infer entitlement from creation time.'
    ].join(' '),
    prompt: `Admin question:\n${cleanQuestion}\n\nRead-only data snapshot:\n${JSON.stringify(readSnapshot)}`,
    output: Output.object({ schema: answerSchema }),
    maxOutputTokens: 700,
    temperature: 0
  })

  const answer = String(result?.output?.answer || '').trim()
  if (!result?.output?.resolved) {
    return {
      answer: answer || 'That question cannot be resolved from the available Seatline data.',
      refused: false,
      unresolved: true,
      model: selectedModel,
      generatedAt: readSnapshot.generatedAt
    }
  }
  if (!answer) {
    const error = new Error('The Admin AI assistant could not resolve that question from the available data. Try a more specific question.')
    error.status = 502
    throw error
  }
  return { answer, refused: false, unresolved: false, model: selectedModel, generatedAt: readSnapshot.generatedAt }
}
