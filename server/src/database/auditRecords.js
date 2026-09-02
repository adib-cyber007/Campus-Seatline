export function deriveAuditRecords(state) {
  const userName = id => state.users.find(item => item.id === id)?.name || id
  const busName = id => state.buses.find(item => item.id === id)?.name || id
  const stopName = id => state.stops.find(item => item.id === id)?.name || id
  const tripFor = id => state.trips.find(item => item.id === id)
  const records = state.reportAttempts.map(item => ({
    id: item.id, kind: 'report_attempt', actorUserId: item.userId,
    busId: item.busId, stopId: item.stopId || null, tripId: item.tripId || null,
    tripDate: item.tripDate, tripDirection: item.tripDirection || tripFor(item.tripId)?.direction || 'morning',
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
      busId: item.busId, stopId: item.stopId, tripId: item.tripId || null,
      tripDate: item.tripDate, tripDirection: item.tripDirection || tripFor(item.tripId)?.direction || 'morning',
      outcome: item.inferred ? 'inferred_crossed' : 'confirmed',
      detail: item.inferred
        ? `Bus ${busName(item.busId)} inferred past Stop ${stopName(item.stopId)} after confirmation at ${stopName(item.inferredFromStopId)}`
        : `Bus ${busName(item.busId)} confirmed at Stop ${stopName(item.stopId)}`,
      metadata: {
        confirmedByUserIds: item.confirmedByUserIds,
        inferred: Boolean(item.inferred),
        inferredFromStopId: item.inferredFromStopId || null
      },
      timestamp: item.timestamp
    })
  }

  for (const item of state.overrides) {
    records.push({
      id: item.id, kind: 'incharge_override', actorUserId: item.inchargeId,
      busId: item.busId, stopId: null, tripId: item.tripId || null,
      tripDate: item.tripDate, tripDirection: item.tripDirection || tripFor(item.tripId)?.direction || 'morning', outcome: 'accepted',
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
      busId: item.busId, stopId: item.stopId, tripId: item.tripId || null,
      tripDate: item.tripDate, tripDirection: item.tripDirection || tripFor(item.tripId)?.direction || 'morning',
      outcome: item.hadAlternateBus ? 'had_alternative' : 'stranded',
      detail: `${userName(item.userId)} could not get a seat on Bus ${busName(item.busId)} at Stop ${stopName(item.stopId)}` +
        (item.hadAlternateBus ? ' · alternate bus available' : ' · no alternate bus available'),
      metadata: { channel: item.channel, alternateBusIds: item.alternateBusIds },
      timestamp: item.timestamp
    })
  }

  for (const item of state.tripClosures || []) {
    const trip = tripFor(item.tripId)
    records.push({
      id: item.id, kind: 'trip_closed', actorUserId: null,
      busId: trip?.busId || null, stopId: null, tripId: item.tripId,
      tripDate: trip?.date || null, tripDirection: trip?.direction || null,
      outcome: item.reason,
      detail: `Force-closed ${trip?.direction || 'unknown'} trip for Bus ${busName(trip?.busId)} with ${item.finalSeatsOccupied} occupied and ${item.finalSoftHolds} Soft Hold${item.finalSoftHolds === 1 ? '' : 's'}`,
      metadata: {
        reason: item.reason, finalBaseOccupied: item.finalBaseOccupied,
        finalManualAdjustment: item.finalManualAdjustment,
        finalSeatsOccupied: item.finalSeatsOccupied, finalSoftHolds: item.finalSoftHolds,
        unresolvedSoftHolds: item.unresolvedSoftHolds
      },
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
  for (const item of state.users.filter(user => user.active === false && user.archivedAt)) {
    records.push({
      id: `${item.id}-archived`, kind: 'user_archived', actorUserId: item.archivedByAdminId || null,
      busId: null, stopId: null, tripDate: null, outcome: 'archived',
      detail: `Archived ${item.role === 'admin' ? 'Admin' : 'Rider'} account ${item.name}`,
      metadata: { userId: item.id, role: item.role, email: item.email }, timestamp: item.archivedAt
    })
  }
  return records
}
