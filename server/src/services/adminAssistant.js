import { generateText, Output } from 'ai'
import { z } from 'zod'
import { getDb, busById, stopById, todayKey, userById } from '../db.js'
import { auditSnapshot } from './audit.js'

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

export function isWriteRequest(question) {
  return WRITE_REQUEST.test(String(question || ''))
}

export function adminReadSnapshot() {
  const db = getDb()
  const tripDate = todayKey()
  const activeAssignments = db.inchargeAssignments.filter(item => !item.revokedAt)
  const occupancy = db.buses.map(bus => {
    const reports = db.boardingReports.filter(item => item.busId === bus.id && item.tripDate === tripDate)
    const baseOccupied = reports.filter(item => item.state === 'seats_occupied').length
    const softHolds = reports.filter(item => item.state === 'soft_hold').length
    const stored = db.occupancy[bus.id]
    const manualAdjustment = stored?.tripDate === tripDate ? stored.manualAdjustment : 0
    const seatsOccupied = Math.min(bus.capacity, Math.max(0, baseOccupied + manualAdjustment))
    return {
      busId: bus.id,
      seatsOccupied,
      softHolds,
      availableSeats: Math.min(bus.capacity, Math.max(0, bus.capacity - seatsOccupied - softHolds))
    }
  })

  const value = {
    tripDate,
    generatedAt: new Date().toISOString(),
    stops: db.stops.map(stop => ({
      id: stop.id,
      name: stop.name,
      timeline: stop.timeline,
      buses: stop.busIds.map(busId => busById(busId)?.name || busId),
      inchargeAssignments: activeAssignments
        .filter(item => (item.scopeType === 'stop' && item.stopId === stop.id) ||
          (item.scopeType === 'bus' && stop.busIds.includes(item.busId)))
        .map(item => userById(item.riderId)?.name || item.riderId)
    })),
    buses: db.buses.map(bus => {
      const counts = occupancy.find(item => item.busId === bus.id)
      return {
        id: bus.id,
        name: bus.name,
        capacity: bus.capacity,
        stops: bus.stopIds.map(stopId => stopById(stopId)?.name || stopId),
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
    const error = new Error('Enter a question about stops, buses, occupancy, Incharge assignments, or the audit log.')
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
