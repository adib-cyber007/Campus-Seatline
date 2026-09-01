import { deriveAuditRecords } from './auditRecords.js'
import { beaconIdentityForBus } from '../beaconIdentity.js'

const iso = value => value instanceof Date ? value.toISOString() : value || null
const day = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value)
const parsed = value => typeof value === 'string' ? JSON.parse(value) : value

export function emptyState() {
  return {
    users: [], stops: [], buses: [], occupancy: {}, boardingReports: [], reportAttempts: [],
    inchargeAssignments: [], arrivalEvents: [], prompts: [], notifications: [], overrides: [],
    dailyStopOverrides: [], autoHoldEvaluations: [], deviceTokens: [], unmetDemandEvents: [], auditRecords: []
  }
}

export async function loadState(client) {
  const state = emptyState()
  const results = {}
  for (const table of [
    'users', 'stops', 'buses', 'bus_beacons', 'user_stops', 'bus_stops', 'occupancy_adjustments',
    'boarding_reports', 'report_attempts', 'unmet_demand_events', 'incharge_assignments', 'arrival_events',
    'arrival_event_confirmations', 'ble_prompts', 'notifications', 'incharge_overrides',
    'daily_stop_overrides', 'auto_hold_evaluations', 'fcm_device_tokens', 'audit_records'
  ]) {
    results[table] = (await client.query(`SELECT * FROM ${table}`)).rows
  }

  state.users = results.users.map(row => ({
    id: row.id, name: row.name, email: row.email, passwordHash: row.password_hash,
    role: row.role, active: row.active,
    archivedAt: iso(row.archived_at), archivedByAdminId: row.archived_by_admin_id,
    stopIds: results.user_stops.filter(link => link.user_id === row.id)
      .sort((a, b) => a.position - b.position).map(link => link.stop_id)
  }))
  state.buses = results.buses.map(row => {
    const persistedBeacon = results.bus_beacons.find(item => item.bus_id === row.id)
    return {
      id: row.id, name: row.name, capacity: row.capacity, active: row.active,
      archivedAt: iso(row.archived_at), archivedByAdminId: row.archived_by_admin_id,
      stopIds: results.bus_stops.filter(link => link.bus_id === row.id)
        .sort((a, b) => a.position - b.position).map(link => link.stop_id),
      beacon: beaconIdentityForBus(row.id, persistedBeacon ? {
        serviceUuid: persistedBeacon.service_uuid,
        advertisingMode: persistedBeacon.advertising_mode,
        advertisingIntervalMs: persistedBeacon.advertising_interval_ms,
        active: persistedBeacon.active
      } : null)
    }
  })
  state.stops = results.stops.map(row => ({
    id: row.id, name: row.name, timeline: parsed(row.timeline) || [], active: row.active,
    archivedAt: iso(row.archived_at), archivedByAdminId: row.archived_by_admin_id,
    busIds: results.bus_stops.filter(link => link.stop_id === row.id)
      .sort((a, b) => a.position - b.position).map(link => link.bus_id)
  }))
  for (const row of results.occupancy_adjustments) {
    state.occupancy[row.bus_id] = {
      busId: row.bus_id, tripDate: day(row.trip_date),
      manualAdjustment: row.manual_adjustment, lastUpdated: iso(row.last_updated)
    }
  }
  state.boardingReports = results.boarding_reports.map(row => ({
    id: row.id, userId: row.user_id, busId: row.bus_id, stopId: row.stop_id,
    tripDate: day(row.trip_date), state: row.state, source: row.source,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    ...(row.release_reason ? { releaseReason: row.release_reason } : {}),
    ...(row.released_at ? { releasedAt: iso(row.released_at) } : {})
  }))
  state.reportAttempts = results.report_attempts.map(row => ({
    id: row.id, userId: row.user_id, busId: row.bus_id, stopId: row.stop_id,
    tripDate: day(row.trip_date), channel: row.channel, requested: row.requested,
    outcome: row.outcome, message: row.message, timestamp: iso(row.timestamp)
  }))
  state.unmetDemandEvents = results.unmet_demand_events.map(row => ({
    id: row.id, userId: row.rider_id, stopId: row.stop_id, busId: row.bus_id,
    channel: row.channel, tripDate: day(row.trip_date), hadAlternateBus: row.had_alternate_bus,
    alternateBusIds: parsed(row.alternate_bus_ids) || [], timestamp: iso(row.timestamp)
  }))
  state.inchargeAssignments = results.incharge_assignments.map(row => ({
    id: row.id, riderId: row.rider_id, scopeType: row.scope_type, busId: row.bus_id,
    stopId: row.stop_id, grantedByAdminId: row.granted_by_admin_id,
    grantedAt: iso(row.granted_at), revokedAt: iso(row.revoked_at),
    ...(row.revoked_by_admin_id ? { revokedByAdminId: row.revoked_by_admin_id } : {})
  }))
  state.arrivalEvents = results.arrival_events.map(row => ({
    id: row.id, busId: row.bus_id, stopId: row.stop_id, tripDate: day(row.trip_date),
    timestamp: iso(row.timestamp), inferred: Boolean(row.inferred),
    inferredFromStopId: row.inferred_from_stop_id || null,
    confirmedByUserIds: results.arrival_event_confirmations
      .filter(item => item.arrival_event_id === row.id)
      .sort((a, b) => new Date(a.confirmed_at) - new Date(b.confirmed_at))
      .map(item => item.user_id)
  }))
  state.prompts = results.ble_prompts.map(row => ({
    id: row.id, userId: row.user_id, busId: row.bus_id, stopId: row.stop_id,
    kind: row.kind, detectionSource: row.detection_source, beacon: parsed(row.beacon),
    status: row.status, tripDate: day(row.trip_date), createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at), ...(row.answered_at ? { answeredAt: iso(row.answered_at) } : {})
  }))
  state.notifications = results.notifications.map(row => ({
    id: row.id, userId: row.user_id, message: row.message,
    type: row.type, createdAt: iso(row.created_at)
  }))
  state.overrides = results.incharge_overrides.map(row => ({
    id: row.id, inchargeId: row.incharge_id, busId: row.bus_id,
    tripDate: day(row.trip_date), previousAvailable: row.previous_available,
    newAvailable: row.new_available, previousOccupied: row.previous_occupied,
    newOccupied: row.new_occupied, timestamp: iso(row.timestamp)
  }))
  state.dailyStopOverrides = results.daily_stop_overrides.map(row => ({
    id: row.id, userId: row.user_id, stopId: row.stop_id, tripDate: day(row.trip_date),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  }))
  state.autoHoldEvaluations = results.auto_hold_evaluations.map(row => ({
    id: row.id, userId: row.user_id, tripDate: day(row.trip_date), contextKey: row.context_key,
    stopIds: parsed(row.stop_ids), viableBusIds: parsed(row.viable_bus_ids),
    outcome: row.outcome, error: row.error, createdAt: iso(row.created_at)
  }))
  state.deviceTokens = results.fcm_device_tokens.map(row => ({
    id: row.id, userId: row.user_id, fcmToken: row.fcm_token, platform: row.platform,
    active: row.active, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    lastSeenAt: iso(row.last_seen_at),
    ...(row.deactivated_at ? { deactivatedAt: iso(row.deactivated_at) } : {}),
    ...(row.deactivation_reason ? { deactivationReason: row.deactivation_reason } : {})
  }))
  state.auditRecords = results.audit_records.map(row => ({
    id: row.id, kind: row.kind, actorUserId: row.actor_user_id,
    busId: row.bus_id, stopId: row.stop_id,
    tripDate: row.trip_date ? day(row.trip_date) : null,
    outcome: row.outcome, detail: row.detail, metadata: parsed(row.metadata),
    timestamp: iso(row.timestamp)
  }))
  return state
}

async function insertRows(client, statement, rows) {
  for (const values of rows) await client.query(statement, values)
}

export async function saveState(client, state) {
  state.auditRecords = deriveAuditRecords(state)
  await client.query(`TRUNCATE TABLE
    arrival_event_confirmations, audit_records, unmet_demand_events, report_attempts, incharge_overrides,
    notifications, fcm_device_tokens, ble_prompts, arrival_events, auto_hold_evaluations,
    daily_stop_overrides, boarding_reports, occupancy_adjustments, incharge_assignments,
    user_stops, bus_stops, bus_beacons, users, buses, stops CASCADE`)

  await insertRows(client, `INSERT INTO stops
    (id,name,timeline,active,archived_at,archived_by_admin_id) VALUES ($1,$2,$3::jsonb,$4,$5,$6)`,
    state.stops.map(item => [item.id, item.name, JSON.stringify(item.timeline || []),
      item.active !== false, item.archivedAt || null, item.archivedByAdminId || null]))
  await insertRows(client, `INSERT INTO buses
    (id,name,capacity,active,archived_at,archived_by_admin_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    state.buses.map(item => [item.id, item.name, item.capacity,
      item.active !== false, item.archivedAt || null, item.archivedByAdminId || null]))
  await insertRows(client, `INSERT INTO bus_beacons
    (bus_id,service_uuid,advertising_mode,advertising_interval_ms,active)
    VALUES ($1,$2,$3,$4,$5)`, state.buses.map(item => {
    item.beacon = beaconIdentityForBus(item.id, item.beacon)
    return [item.id, item.beacon.serviceUuid, item.beacon.advertisingMode,
      item.beacon.advertisingIntervalMs, item.beacon.active]
  }))
  await insertRows(client, `INSERT INTO users
    (id,name,email,password_hash,role,active,archived_at,archived_by_admin_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, state.users.map(item => [
    item.id, item.name, item.email, item.passwordHash, item.role,
    item.active !== false, item.archivedAt || null, item.archivedByAdminId || null
  ]))
  await insertRows(client, `INSERT INTO user_stops (user_id,stop_id,position) VALUES ($1,$2,$3)`,
    state.users.flatMap(user => user.stopIds.map((stopId, position) => [user.id, stopId, position])))
  await insertRows(client, `INSERT INTO bus_stops (bus_id,stop_id,position) VALUES ($1,$2,$3)`,
    state.buses.flatMap(bus => bus.stopIds.map((stopId, position) => [bus.id, stopId, position])))
  await insertRows(client, `INSERT INTO incharge_assignments
    (id,rider_id,scope_type,bus_id,stop_id,granted_by_admin_id,granted_at,revoked_at,revoked_by_admin_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, state.inchargeAssignments.map(item => [
    item.id, item.riderId, item.scopeType, item.busId || null, item.stopId || null,
    item.grantedByAdminId, item.grantedAt, item.revokedAt || null, item.revokedByAdminId || null
  ]))
  await insertRows(client, `INSERT INTO boarding_reports
    (id,user_id,bus_id,stop_id,trip_date,state,source,release_reason,released_at,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, state.boardingReports.map(item => [
    item.id, item.userId, item.busId, item.stopId || null, item.tripDate, item.state, item.source,
    item.releaseReason || null, item.releasedAt || null, item.createdAt, item.updatedAt
  ]))
  await insertRows(client, `INSERT INTO occupancy_adjustments
    (bus_id,trip_date,manual_adjustment,last_updated) VALUES ($1,$2,$3,$4)`,
    Object.values(state.occupancy).map(item => [item.busId, item.tripDate, item.manualAdjustment, item.lastUpdated]))
  await insertRows(client, `INSERT INTO ble_prompts
    (id,user_id,bus_id,stop_id,kind,detection_source,beacon,status,trip_date,created_at,expires_at,answered_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`, state.prompts.map(item => [
    item.id, item.userId, item.busId, item.stopId, item.kind, item.detectionSource,
    item.beacon ? JSON.stringify(item.beacon) : null, item.status, item.tripDate,
    item.createdAt, item.expiresAt, item.answeredAt || null
  ]))
  await insertRows(client, `INSERT INTO arrival_events
    (id,bus_id,stop_id,trip_date,timestamp,inferred,inferred_from_stop_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, state.arrivalEvents.map(item => [
      item.id, item.busId, item.stopId, item.tripDate, item.timestamp,
      Boolean(item.inferred), item.inferredFromStopId || null
    ]))
  await insertRows(client, `INSERT INTO arrival_event_confirmations
    (arrival_event_id,user_id,confirmed_at) VALUES ($1,$2,$3)`, state.arrivalEvents.flatMap(event =>
    event.confirmedByUserIds.map(userId => [event.id, userId, event.timestamp])))
  await insertRows(client, `INSERT INTO report_attempts
    (id,user_id,bus_id,stop_id,trip_date,channel,requested,outcome,message,timestamp)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, state.reportAttempts.map(item => [
    item.id, item.userId, item.busId, item.stopId || null, item.tripDate, item.channel,
    item.requested, item.outcome, item.message || null, item.timestamp
  ]))
  await insertRows(client, `INSERT INTO unmet_demand_events
    (id,rider_id,stop_id,bus_id,channel,trip_date,had_alternate_bus,alternate_bus_ids,timestamp)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`, state.unmetDemandEvents.map(item => [
    item.id, item.userId, item.stopId, item.busId, item.channel, item.tripDate,
    item.hadAlternateBus, JSON.stringify(item.alternateBusIds || []), item.timestamp
  ]))
  await insertRows(client, `INSERT INTO incharge_overrides
    (id,incharge_id,bus_id,trip_date,previous_available,new_available,previous_occupied,new_occupied,timestamp)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, state.overrides.map(item => [
    item.id, item.inchargeId, item.busId, item.tripDate, item.previousAvailable,
    item.newAvailable, item.previousOccupied, item.newOccupied, item.timestamp
  ]))
  await insertRows(client, `INSERT INTO daily_stop_overrides
    (id,user_id,stop_id,trip_date,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    state.dailyStopOverrides.map(item => [item.id, item.userId, item.stopId, item.tripDate, item.createdAt, item.updatedAt]))
  await insertRows(client, `INSERT INTO auto_hold_evaluations
    (id,user_id,trip_date,context_key,stop_ids,viable_bus_ids,outcome,error,created_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)`, state.autoHoldEvaluations.map(item => [
    item.id, item.userId, item.tripDate, item.contextKey, JSON.stringify(item.stopIds),
    JSON.stringify(item.viableBusIds), item.outcome, item.error || null, item.createdAt
  ]))
  await insertRows(client, `INSERT INTO notifications
    (id,user_id,message,type,created_at) VALUES ($1,$2,$3,$4,$5)`,
    state.notifications.map(item => [item.id, item.userId, item.message, item.type, item.createdAt]))
  await insertRows(client, `INSERT INTO fcm_device_tokens
    (id,user_id,fcm_token,platform,active,created_at,updated_at,last_seen_at,deactivated_at,deactivation_reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, state.deviceTokens.map(item => [
    item.id, item.userId, item.fcmToken, item.platform, item.active, item.createdAt,
    item.updatedAt, item.lastSeenAt, item.deactivatedAt || null, item.deactivationReason || null
  ]))
  await insertRows(client, `INSERT INTO audit_records
    (id,kind,actor_user_id,bus_id,stop_id,trip_date,outcome,detail,metadata,timestamp)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`, state.auditRecords.map(item => [
    item.id, item.kind, item.actorUserId || null, item.busId || null, item.stopId || null,
    item.tripDate || null, item.outcome || null, item.detail, JSON.stringify(item.metadata || {}), item.timestamp
  ]))
}
