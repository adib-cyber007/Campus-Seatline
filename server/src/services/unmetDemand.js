import { getDb, nextId, busByIdIncludingArchived, stopByIdIncludingArchived, userById, todayKey } from '../db.js'
import { emitAdmins } from '../realtime.js'
import { sendPushIfUserOffline } from './push.js'

export function recordUnmetDemand({ userId, trip = null, stopId, busId, channel, alternateBusIds = [] }) {
  const event = {
    id: nextId(),
    userId,
    tripId: trip?.id || null,
    stopId,
    busId,
    channel,
    tripDate: trip?.date || todayKey(),
    tripDirection: trip?.direction || 'morning',
    hadAlternateBus: alternateBusIds.length > 0,
    alternateBusIds: [...new Set(alternateBusIds)],
    timestamp: new Date().toISOString()
  }
  getDb().unmetDemandEvents.push(event)
  emitAdmins('refresh', { reason: 'unmet-demand-recorded' })
  const busName = busByIdIncludingArchived(busId)?.name || 'the selected bus'
  const stopName = stopByIdIncludingArchived(stopId)?.name || 'your stop'
  const alternativeNote = event.hadAlternateBus
    ? 'Another bus option currently has seats.'
    : 'No alternate bus with available seats is currently shown.'
  void sendPushIfUserOffline({
    userId,
    title: `Seat unavailable on ${busName}`,
    body: `${busName} could not accept your report at ${stopName}. ${alternativeNote}`,
    data: {
      event_type: 'unmet_demand_alert',
      event_id: event.id,
      trip_id: event.tripId,
      trip_direction: event.tripDirection,
      bus_id: busId,
      stop_id: stopId
    }
  })
  return event
}

export function enrichedUnmetDemandEvents() {
  return getDb().unmetDemandEvents
    .map(event => ({
      ...event,
      riderName: userById(event.userId)?.name || event.userId,
      riderEmail: userById(event.userId)?.email || null,
      stopName: stopByIdIncludingArchived(event.stopId)?.name || event.stopId,
      busName: busByIdIncludingArchived(event.busId)?.name || event.busId,
      alternateBusNames: event.alternateBusIds
        .map(id => busByIdIncludingArchived(id)?.name || id)
    }))
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
}

export function aggregateUnmetDemand(events = enrichedUnmetDemandEvents()) {
  const groups = new Map()
  for (const event of events) {
    const key = `${event.tripDate}:${event.tripDirection}:${event.stopId}:${event.busId}`
    const group = groups.get(key) || {
      key,
      stopId: event.stopId,
      stopName: event.stopName,
      busId: event.busId,
      busName: event.busName,
      tripDate: event.tripDate,
      tripDirection: event.tripDirection || 'morning',
      count: 0,
      strandedCount: 0,
      hadAlternativeCount: 0,
      latestAt: event.timestamp
    }
    group.count += 1
    if (event.hadAlternateBus) group.hadAlternativeCount += 1
    else group.strandedCount += 1
    if (String(event.timestamp) > String(group.latestAt)) group.latestAt = event.timestamp
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) =>
    b.strandedCount - a.strandedCount || b.count - a.count || a.stopName.localeCompare(b.stopName)
  )
}
