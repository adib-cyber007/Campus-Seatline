import jwt from 'jsonwebtoken'
import { userById } from './db.js'

const SECRET = process.env.JWT_SECRET || 'mvp-dev-secret-change-me'

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, SECRET, { expiresIn: '7d' })
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET)
}

export function authenticate(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Missing token' })
  try {
    const payload = verifyToken(token)
    const user = userById(payload.sub)
    if (!user) return res.status(401).json({ error: 'Unknown user' })
    req.user = user
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden for this role' })
    }
    next()
  }
}
