import { io } from 'socket.io-client'
import { getToken } from './api'

export function connectSocket() {
  return io('/', { auth: { token: getToken() } })
}
