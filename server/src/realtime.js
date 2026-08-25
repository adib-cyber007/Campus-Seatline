let io = null

export function setIo(instance) {
  io = instance
}

export function emitToUser(userId, event, payload) {
  if (io) io.to(`user:${userId}`).emit(event, payload)
}

export function emitAll(event, payload) {
  if (io) io.emit(event, payload)
}

export function emitAdmins(event, payload) {
  if (io) io.to('role:admin').emit(event, payload)
}

export function isUserConnected(userId) {
  return Boolean(io?.sockets?.adapter?.rooms?.get(`user:${userId}`)?.size)
}
