import express from 'express'
import cors from 'cors'
import authRoutes from './routes/auth.js'
import metaRoutes from './routes/meta.js'
import meRoutes from './routes/me.js'
import riderRoutes from './routes/rider.js'
import adminRoutes from './routes/admin.js'
import { onDetection } from './services/bleGateway.js'
import { handleDetection } from './services/occupancy.js'

onDetection(handleDetection)

export const app = express()

app.use(cors())
app.use(express.json())

app.get('/api/health', (req, res) => res.json({ ok: true, gps: 'not-used-anywhere' }))

app.use('/api/auth', authRoutes)
app.use('/api/meta', metaRoutes)
app.use('/api/me', meRoutes)
app.use('/api/rider', riderRoutes)
app.use('/api/admin', adminRoutes)

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
})
