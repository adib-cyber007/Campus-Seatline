import { Router } from 'express'
import { getDb, nextId, hashPassword, verifyPassword, sanitizeUser, stopById } from '../db.js'
import { signToken } from '../auth.js'
import { emitAdmins } from '../realtime.js'

const router = Router()

router.post('/login', (req, res) => {
  const { email, password } = req.body || {}
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
  const normalizedEmail = String(email).trim().toLowerCase()
  const user = getDb().users.find(u => u.active !== false && u.email.toLowerCase() === normalizedEmail)
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }
  res.json({ token: signToken(user), user: sanitizeUser(user) })
})

router.post('/register', (req, res) => {
  const { name, email, password, role, stopIds } = req.body || {}
  const cleanName = String(name || '').trim()
  const cleanEmail = String(email || '').trim().toLowerCase()
  if (!cleanName || !cleanEmail || !password) return res.status(400).json({ error: 'Name, email and password required' })
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })
  if (role !== 'rider') return res.status(400).json({ error: 'Only rider accounts can self-register; Incharge is an authority granted by an Admin' })
  if (!Array.isArray(stopIds) || stopIds.length === 0) return res.status(400).json({ error: 'Select at least one stop' })
  const db = getDb()
  if (db.users.some(u => u.email.toLowerCase() === cleanEmail)) {
    return res.status(409).json({ error: 'Email already registered' })
  }
  const validStops = stopIds.every(id => stopById(id))
  if (!validStops) return res.status(400).json({ error: 'Unknown stop in selection' })

  const user = {
    id: nextId(), name: cleanName, email: cleanEmail, role,
    passwordHash: hashPassword(password),
    stopIds: [...new Set(stopIds)], active: true
  }
  db.users.push(user)
  emitAdmins('refresh', { reason: 'rider-registered' })
  res.status(201).json({ token: signToken(user), user: sanitizeUser(user) })
})

export default router
