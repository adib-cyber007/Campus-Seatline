export function deriveAuditRecords(state) {
  const userName = id => state.users.find(item => item.id === id)?.name || id
  const busName = id => state.buses.find(item => item.id === id)?.name || id
  const stopName = id => state.stops.find(item => item.id === id)?.name || id
  const records = state.reportAttempts.map(item => ({
    id: item.id, kind: 'report_attempt', actorUserId: item.userId,
    busId: item.busId, stopId: item.stopId || null, tripDate: item.tripDate,
    outcome: item.outcome,
    detail: `${item.channel} "${String(item.requested).toUpperCase()}" -> ${item.outcome} · Bus ${busName(item.busId)}` +
      (item.stopId ? ` · Stop ${stopName(item.stopId)}` : '') +
      (item.message ? ` — ${item.message}` : ''),
    metadata: { channel: item.channel, requested: item.requested, message: item.message || null },
    timestamp: item.timestamp
  }))

  for (const item of state.arrivalEvents) {
    records.push({
      id: item.id, kind: 'arrival_event', actorUserId: item.confirmedByUserIds[0] || null,
      busId: item.busId, stopId: item.stopId, tripDate: item.tripDate, outcome: 'confirmed',
      detail: `Bus ${busName(item.busId)} confirmed at Stop ${stopName(item.stopId)}`,
      metadata: { confirmedByUserIds: item.confirmedByUserIds }, timestamp: item.timestamp
    })
  }

  for (const item of state.overrides) {
    records.push({
      id: item.id, kind: 'incharge_override', actorUserId: item.inchargeId,
      busId: item.busId, stopId: null, tripDate: item.tripDate, outcome: 'accepted',
      detail: `Bus ${busName(item.busId)}: Seats Available ${item.previousAvailable} -> ${item.newAvailable} ` +
        `(Seats Occupied derived ${item.previousOccupied} -> ${item.newOccupied})`,
      metadata: {
        previousAvailable: item.previousAvailable, newAvailable: item.newAvailable,
        previousOccupied: item.previousOccupied, newOccupied: item.newOccupied
      },
      timestamp: item.timestamp
    })
  }

  for (const item of state.inchargeAssignments) {
    const scope = item.scopeType === 'bus'
      ? `Bus ${busName(item.busId)}`
      : `Stop ${stopName(item.stopId)}`
    records.push({
      id: `${item.id}-grant`, kind: 'incharge_assignment',
      actorUserId: item.grantedByAdminId, busId: item.busId || null, stopId: item.stopId || null,
      tripDate: null, outcome: 'granted',
      detail: `Granted Incharge authority over ${scope} to ${userName(item.riderId)}`,
      metadata: { riderId: item.riderId, scopeType: item.scopeType }, timestamp: item.grantedAt
    })
    if (item.revokedAt) {
      records.push({
        id: `${item.id}-revoke`, kind: 'incharge_assignment',
        actorUserId: item.revokedByAdminId || null,
        busId: item.busId || null, stopId: item.stopId || null,
        tripDate: null, outcome: 'revoked',
        detail: `Revoked Incharge authority over ${scope} from ${userName(item.riderId)}`,
        metadata: { riderId: item.riderId, scopeType: item.scopeType }, timestamp: item.revokedAt
      })
    }
  }
  for (const item of state.unmetDemandEvents) {
    records.push({
      id: item.id, kind: 'unmet_demand', actorUserId: item.userId,
      busId: item.busId, stopId: item.stopId, tripDate: item.tripDate,
      outcome: item.hadAlternateBus ? 'had_alternative' : 'stranded',
      detail: `${userName(item.userId)} could not get a seat on Bus ${busName(item.busId)} at Stop ${stopName(item.stopId)}` +
        (item.hadAlternateBus ? ' · alternate bus available' : ' · no alternate bus available'),
      metadata: { channel: item.channel, alternateBusIds: item.alternateBusIds },
      timestamp: item.timestamp
    })
  }

  for (const item of [...state.buses, ...state.stops].filter(entity => entity.active === false && entity.archivedAt)) {
    const isBus = Object.prototype.hasOwnProperty.call(item, 'capacity')
    records.push({
      id: `${item.id}-archived`, kind: 'entity_archived', actorUserId: item.archivedByAdminId || null,
      busId: isBus ? item.id : null, stopId: isBus ? null : item.id, tripDate: null,
      outcome: 'archived', detail: `Archived ${isBus ? 'Bus' : 'Stop'} ${item.name}`,
      metadata: { entityType: isBus ? 'bus' : 'stop' }, timestamp: item.archivedAt
    })
  }
  return records
}
