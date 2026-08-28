import { Router } from 'express'
import { activeStops } from '../db.js'

const router = Router()

router.get('/', (req, res) => {
  res.json({ stops: activeStops().map(({ id, name }) => ({ id, name })) })
})

export default router
