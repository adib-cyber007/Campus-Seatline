import { Router } from 'express'
import { getDb, verifyPassword, sanitizeUser } from '../db.js'
import { signToken } from '../auth.js'

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

export default router
