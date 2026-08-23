import { Router } from 'express'
import { getDb } from '../db.js'

const router = Router()

router.get('/', (req, res) => {
  res.json({ stops: getDb().stops.map(({ id, name }) => ({ id, name })) })
})

export default router
