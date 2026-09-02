import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { app } from './app.js'
import { setIo } from './realtime.js'
import { verifyToken } from './auth.js'
import { snapshot } from './services/occupancy.js'
import { userById } from './db.js'
import { startTripScheduler } from './services/trips.js'

const httpServer = createServer(app)
const io = new Server(httpServer, { cors: { origin: true } })

io.use((socket, next) => {
  try {
    const payload = verifyToken(socket.handshake.auth?.token)
    const user = userById(payload.sub)
    if (!user) return next(new Error('unauthorized'))
    socket.data.userId = user.id
    socket.data.role = user.role
    next()
  } catch {
    next(new Error('unauthorized'))
  }
})

io.on('connection', socket => {
  socket.join(`user:${socket.data.userId}`)
  socket.join(`role:${socket.data.role}`)
  socket.emit('occupancy', snapshot())
})

setIo(io)
startTripScheduler()

const PORT = process.env.PORT || 4000
httpServer.listen(PORT, () => console.log(`API + WebSocket listening on http://localhost:${PORT}`))
