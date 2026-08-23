import { io } from 'socket.io-client'
import { getApiOrigin, getToken } from './api'

export function connectSocket() {
  return io(getApiOrigin() || window.location.origin, { auth: { token: getToken() } })
}
