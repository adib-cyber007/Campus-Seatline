import { getDb, userById, busById, stopById } from '../db.js'

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
        ` · Bus ${busById(a.busId)?.name || a.busId}` +
        (a.stopId ? ` · Stop ${stopById(a.stopId)?.name || a.stopId}` : '') +
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
      detail: `Bus ${busById(e.busId)?.name || e.busId} confirmed at Stop ${stopById(e.stopId)?.name || e.stopId}` +
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
      detail: `Bus ${busById(o.busId)?.name || o.busId}: Seats Available ${o.previousAvailable} → ${o.newAvailable}` +
        ` (Seats Occupied derived ${o.previousOccupied} → ${o.newOccupied})` +
        tripLabel(o.tripDate)
    })
  }

  for (const g of db.inchargeAssignments) {
    const scope = g.scopeType === 'bus'
      ? `Bus ${busById(g.busId)?.name || g.busId}`
      : `Stop ${stopById(g.stopId)?.name || g.stopId}`
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

  return items.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
}
