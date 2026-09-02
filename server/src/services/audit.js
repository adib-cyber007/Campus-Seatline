import {
  getDb, userById, busByIdIncludingArchived, stopByIdIncludingArchived
} from '../db.js'

function tripLabel(tripDate, tripDirection) {
  return tripDate ? ` · ${tripDirection || 'morning'} trip ${tripDate}` : ''
}

export function auditSnapshot() {
  const db = getDb()
  const items = []

  for (const a of db.reportAttempts) {
    items.push({
      id: a.id,
      kind: 'report_attempt',
      timestamp: a.timestamp,
      actor: userById(a.userId)?.name || a.userId,
      tripId: a.tripId || null,
      tripDate: a.tripDate,
      tripDirection: a.tripDirection || 'morning',
      outcome: a.outcome,
      detail: `${a.channel} "${String(a.requested).toUpperCase()}" → ${a.outcome}` +
        ` · Bus ${busByIdIncludingArchived(a.busId)?.name || a.busId}` +
        (a.stopId ? ` · Stop ${stopByIdIncludingArchived(a.stopId)?.name || a.stopId}` : '') +
        tripLabel(a.tripDate, a.tripDirection) +
        (a.message ? ` — ${a.message}` : '')
    })
  }

  for (const e of db.arrivalEvents) {
    items.push({
      id: e.id,
      kind: 'arrival_event',
      timestamp: e.timestamp,
      tripId: e.tripId || null,
      tripDate: e.tripDate,
      tripDirection: e.tripDirection || 'morning',
      actor: e.inferred
        ? 'System inference'
        : e.confirmedByUserIds.map(id => userById(id)?.name || id).join(', ') || 'unknown',
      outcome: e.inferred ? 'inferred_crossed' : 'confirmed',
      detail: e.inferred
        ? `Bus ${busByIdIncludingArchived(e.busId)?.name || e.busId} inferred past Stop ${stopByIdIncludingArchived(e.stopId)?.name || e.stopId}` +
          ` after confirmation at ${stopByIdIncludingArchived(e.inferredFromStopId)?.name || e.inferredFromStopId}` +
          tripLabel(e.tripDate, e.tripDirection)
        : `Bus ${busByIdIncludingArchived(e.busId)?.name || e.busId} confirmed at Stop ${stopByIdIncludingArchived(e.stopId)?.name || e.stopId}` +
          ` (${e.confirmedByUserIds.length} confirmation${e.confirmedByUserIds.length === 1 ? '' : 's'})` +
          tripLabel(e.tripDate, e.tripDirection)
    })
  }

  for (const o of db.overrides) {
    items.push({
      id: o.id,
      kind: 'incharge_override',
      timestamp: o.timestamp,
      tripId: o.tripId || null,
      tripDate: o.tripDate,
      tripDirection: o.tripDirection || 'morning',
      actor: userById(o.inchargeId)?.name || o.inchargeId,
      detail: `Bus ${busByIdIncludingArchived(o.busId)?.name || o.busId}: Seats Available ${o.previousAvailable} → ${o.newAvailable}` +
        ` (Seats Occupied derived ${o.previousOccupied} → ${o.newOccupied})` +
        tripLabel(o.tripDate, o.tripDirection)
    })
  }

  for (const g of db.inchargeAssignments) {
    const scope = g.scopeType === 'bus'
      ? `Bus ${busByIdIncludingArchived(g.busId)?.name || g.busId}`
      : `Stop ${stopByIdIncludingArchived(g.stopId)?.name || g.stopId}`
    items.push({
      id: `${g.id}-grant`,
      kind: 'incharge_assignment',
      timestamp: g.grantedAt,
      actor: userById(g.grantedByAdminId)?.name || g.grantedByAdminId,
      detail: `Granted Incharge authority over ${scope} to ${userById(g.riderId)?.name || g.riderId}`
    })
    if (g.revokedAt) {
      items.push({
        id: `${g.id}-revoke`,
        kind: 'incharge_assignment',
        timestamp: g.revokedAt,
        actor: userById(g.revokedByAdminId)?.name || g.revokedByAdminId || 'unknown admin',
        detail: `Revoked Incharge authority over ${scope} from ${userById(g.riderId)?.name || g.riderId}`
      })
    }
  }

  for (const event of db.unmetDemandEvents) {
    items.push({
      id: event.id,
      kind: 'unmet_demand',
      timestamp: event.timestamp,
      tripId: event.tripId || null,
      tripDate: event.tripDate,
      tripDirection: event.tripDirection || 'morning',
      actor: userById(event.userId)?.name || event.userId,
      outcome: event.hadAlternateBus ? 'had_alternative' : 'stranded',
      detail: `Could not get a seat on Bus ${busByIdIncludingArchived(event.busId)?.name || event.busId}` +
        ` at Stop ${stopByIdIncludingArchived(event.stopId)?.name || event.stopId}` +
        (event.hadAlternateBus ? ' · alternate bus available' : ' · no alternate bus available') +
        tripLabel(event.tripDate, event.tripDirection)
    })
  }

  for (const closure of db.tripClosures) {
    const trip = db.trips.find(item => item.id === closure.tripId)
    items.push({
      id: closure.id,
      kind: 'trip_closed',
      timestamp: closure.timestamp,
      actor: 'System clock',
      tripId: closure.tripId,
      tripDate: trip?.date || null,
      tripDirection: trip?.direction || null,
      outcome: closure.reason,
      detail: `${trip?.direction || 'Trip'} trip for Bus ${busByIdIncludingArchived(trip?.busId)?.name || trip?.busId || 'unknown'}` +
        ` force-closed · Seats Occupied ${closure.finalSeatsOccupied}` +
        ` · Soft Holds ${closure.finalSoftHolds}` +
        ` · unresolved holds ${closure.unresolvedSoftHolds}` +
        tripLabel(trip?.date, trip?.direction)
    })
  }

  for (const entity of [...db.buses, ...db.stops].filter(item => item.active === false && item.archivedAt)) {
    const isBus = Object.prototype.hasOwnProperty.call(entity, 'capacity')
    items.push({
      id: `${entity.id}-archived`,
      kind: 'entity_archived',
      timestamp: entity.archivedAt,
      actor: userById(entity.archivedByAdminId)?.name || entity.archivedByAdminId || 'unknown admin',
      outcome: 'archived',
      detail: `Archived ${isBus ? 'Bus' : 'Stop'} ${entity.name}; historical records remain available`
    })
  }
  for (const user of db.users.filter(item => item.active === false && item.archivedAt)) {
    items.push({
      id: `${user.id}-archived`,
      kind: 'user_archived',
      timestamp: user.archivedAt,
      actor: userById(user.archivedByAdminId)?.name || user.archivedByAdminId || 'unknown admin',
      outcome: 'archived',
      detail: `Archived ${user.role === 'admin' ? 'Admin' : 'Rider'} account ${user.name}; historical records remain available`
    })
  }
  return items.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
}
