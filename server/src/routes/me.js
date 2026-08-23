import { Router } from 'express'
import { sanitizeUser, stopById } from '../db.js'
import { authenticate } from '../auth.js'

const router = Router()

router.get('/', authenticate, (req, res) => {
  res.json({
    user: sanitizeUser(req.user),
    stopNames: req.user.stopIds.map(id => stopById(id)?.name).filter(Boolean)
  })
})

export default router
