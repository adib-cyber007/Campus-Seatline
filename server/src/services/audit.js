import {
  getDb, userById, busByIdIncludingArchived, stopByIdIncludingArchived
} from '../db.js'

function tripLabel(tripDate) {
  return tripDate ? ` · trip ${tripDate}` : ''
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
      outcome: a.outcome,
      detail: `${a.channel} "${String(a.requested).toUpperCase()}" → ${a.outcome}` +
        ` · Bus ${busByIdIncludingArchived(a.busId)?.name || a.busId}` +
        (a.stopId ? ` · Stop ${stopByIdIncludingArchived(a.stopId)?.name || a.stopId}` : '') +
        tripLabel(a.tripDate) +
        (a.message ? ` — ${a.message}` : '')
    })
  }

  for (const e of db.arrivalEvents) {
    items.push({
      id: e.id,
      kind: 'arrival_event',
      timestamp: e.timestamp,
      actor: e.confirmedByUserIds.map(id => userById(id)?.name || id).join(', ') || 'unknown',
      detail: `Bus ${busByIdIncludingArchived(e.busId)?.name || e.busId} confirmed at Stop ${stopByIdIncludingArchived(e.stopId)?.name || e.stopId}` +
        ` (${e.confirmedByUserIds.length} confirmation${e.confirmedByUserIds.length === 1 ? '' : 's'})` +
        tripLabel(e.tripDate)
    })
  }

  for (const o of db.overrides) {
    items.push({
      id: o.id,
      kind: 'incharge_override',
      timestamp: o.timestamp,
      actor: userById(o.inchargeId)?.name || o.inchargeId,
      detail: `Bus ${busByIdIncludingArchived(o.busId)?.name || o.busId}: Seats Available ${o.previousAvailable} → ${o.newAvailable}` +
        ` (Seats Occupied derived ${o.previousOccupied} → ${o.newOccupied})` +
        tripLabel(o.tripDate)
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
      actor: userById(event.userId)?.name || event.userId,
      outcome: event.hadAlternateBus ? 'had_alternative' : 'stranded',
      detail: `Could not get a seat on Bus ${busByIdIncludingArchived(event.busId)?.name || event.busId}` +
        ` at Stop ${stopByIdIncludingArchived(event.stopId)?.name || event.stopId}` +
        (event.hadAlternateBus ? ' · alternate bus available' : ' · no alternate bus available') +
        tripLabel(event.tripDate)
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
  return items.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
}
