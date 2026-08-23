import crypto from 'node:crypto'

const uid = () => crypto.randomUUID()

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':')
  if (!salt || !hash) return false
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex')
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'))
}

const db = {
  users: [],
  stops: [],
  buses: [],
  occupancy: {},
  boardingReports: [],
  reportAttempts: [],
  inchargeAssignments: [],
  arrivalEvents: [],
  prompts: [],
  notifications: [],
  overrides: []
}

export const nextId = uid
export const getDb = () => db

export function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function occupancyOf(busId) {
  const tripDate = todayKey()
  if (!db.occupancy[busId]) {
    db.occupancy[busId] = { busId, manualAdjustment: 0, lastUpdated: new Date().toISOString(), tripDate }
  } else if (db.occupancy[busId].tripDate !== tripDate) {
    db.occupancy[busId] = {
      busId,
      manualAdjustment: 0,
      lastUpdated: new Date().toISOString(),
      tripDate
    }
  }
  return db.occupancy[busId]
}

export function pushNotification(userId, message, type = 'info') {
  const n = { id: uid(), userId, message, type, createdAt: new Date().toISOString() }
  db.notifications.push(n)
  return n
}

export function sanitizeUser(u) {
  if (!u) return null
  const { passwordHash, ...rest } = u
  return rest
}

export const userById = id => db.users.find(u => u.id === id)
export const busById = id => db.buses.find(b => b.id === id)
export const stopById = id => db.stops.find(s => s.id === id)
export const busesForStops = stopIds =>
  db.buses.filter(b => b.stopIds.some(s => stopIds.includes(s)))

export function activeAssignments() {
  return db.inchargeAssignments.filter(a => !a.revokedAt)
}

export function riderAuthorityBusIds(userId) {
  return db.buses
    .filter(b =>
      activeAssignments().some(a =>
        a.riderId === userId &&
        ((a.scopeType === 'bus' && a.busId === b.id) ||
          (a.scopeType === 'stop' && b.stopIds.includes(a.stopId)))
      )
    )
    .map(b => b.id)
}

function seed() {
  const s1 = uid(), s2 = uid(), s3 = uid(), s4 = uid(), s5 = uid()
  const s6 = uid(), s7 = uid(), s8 = uid(), s9 = uid(), s10 = uid(), s11 = uid()
  const b1 = uid(), b2 = uid()

  db.stops.push(
    { id: s1, name: 'Main Gate', timeline: [{ time: '07:30', label: 'Morning' }], busIds: [b1, b2] },
    { id: s2, name: 'Library Block', timeline: [{ time: '07:45', label: 'Morning' }], busIds: [b1] },
    { id: s3, name: 'Hostel Circle', timeline: [{ time: '08:00', label: 'Morning' }], busIds: [b1] },
    { id: s4, name: 'Sports Complex', timeline: [{ time: '07:50', label: 'Morning' }], busIds: [b2] },
    { id: s5, name: 'North Campus', timeline: [{ time: '08:10', label: 'Morning' }], busIds: [b2] },
    { id: s6, name: 'Annex Road', timeline: [], busIds: [] },
    { id: s7, name: 'City Center', timeline: [], busIds: [] },
    { id: s8, name: 'East Colony', timeline: [], busIds: [] },
    { id: s9, name: 'Old Hospital Junction', timeline: [], busIds: [] },
    { id: s10, name: 'River Side', timeline: [], busIds: [] },
    { id: s11, name: 'Tech Park', timeline: [], busIds: [] }
  )

  const admin = {
    id: uid(), name: 'Admin', email: 'admin@campus.edu',
    passwordHash: hashPassword('admin123'), role: 'admin', stopIds: []
  }
  const inch1 = {
    id: uid(), name: 'Incharge One', email: 'incharge@campus.edu',
    passwordHash: hashPassword('incharge123'), role: 'rider', stopIds: [s1]
  }
  const r1 = {
    id: uid(), name: 'Rider One', email: 'rider@campus.edu',
    passwordHash: hashPassword('rider123'), role: 'rider', stopIds: [s1]
  }
  const r2 = {
    id: uid(), name: 'Rider Two', email: 'rider2@campus.edu',
    passwordHash: hashPassword('rider123'), role: 'rider', stopIds: [s2]
  }
  const r3 = {
    id: uid(), name: 'Rider Three', email: 'rider3@campus.edu',
    passwordHash: hashPassword('rider123'), role: 'rider', stopIds: [s3]
  }
  db.users.push(admin, inch1, r1, r2, r3)

  db.buses.push(
    { id: b1, name: 'Shuttle-01', capacity: 40, stopIds: [s1, s2, s3] },
    { id: b2, name: 'Express-02', capacity: 24, stopIds: [s1, s4, s5] }
  )

  db.inchargeAssignments.push({
    id: uid(),
    riderId: inch1.id,
    scopeType: 'bus',
    busId: b1,
    stopId: null,
    grantedByAdminId: admin.id,
    grantedAt: new Date().toISOString(),
    revokedAt: null
  })
}

seed()
