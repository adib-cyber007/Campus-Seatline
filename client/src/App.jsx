import { useCallback, useEffect, useState } from 'react'
import { api, getToken, setToken } from './api'
import { connectSocket } from './socket'
import LoginPage from './components/LoginPage'
import RiderPage from './components/RiderPage'
import AdminPage from './components/AdminPage'
import Toasts from './components/Toasts'

function BusMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M8 4h16a4 4 0 0 1 4 4v15a3 3 0 0 1-3 3h-1v2a2 2 0 0 1-4 0v-2h-8v2a2 2 0 0 1-4 0v-2H7a3 3 0 0 1-3-3V8a4 4 0 0 1 4-4Z" />
      <path d="M8 8h16v8H8z" className="mark-window" />
      <circle cx="10" cy="21" r="2" className="mark-light" />
      <circle cx="22" cy="21" r="2" className="mark-light" />
    </svg>
  )
}

export default function App() {
  const [user, setUser] = useState(null)
  const [booting, setBooting] = useState(true)
  const [toasts, setToasts] = useState([])
  const [notifications, setNotifications] = useState([])
  const [occupancy, setOccupancy] = useState({})
  const [prompts, setPrompts] = useState(null)
  const [auditFeed, setAuditFeed] = useState(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [connectionStatus, setConnectionStatus] = useState('connecting')

  const toast = useCallback((message, type = 'info') => {
    const id = Math.random().toString(36).slice(2)
    setToasts(list => [...list, { id, message, type }])
    setTimeout(() => setToasts(list => list.filter(t => t.id !== id)), 4500)
  }, [])

  useEffect(() => {
    if (getToken()) {
      api('/me')
        .then(d => setUser(d.user))
        .catch(() => setToken(null))
        .finally(() => setBooting(false))
    } else {
      setBooting(false)
    }
  }, [])

  useEffect(() => {
    if (!user) return
    const s = connectSocket()
    setConnectionStatus('connecting')
    s.on('connect', () => setConnectionStatus('live'))
    s.on('disconnect', () => setConnectionStatus('offline'))
    s.on('connect_error', () => setConnectionStatus('offline'))
    s.on('notification', n => {
      setNotifications(list => [n, ...list].slice(0, 50))
      toast(n.message, n.type)
    })
    s.on('occupancy', snap => {
      setOccupancy(Object.fromEntries(snap.map(o => [o.busId, o])))
    })
    s.on('prompts', setPrompts)
    s.on('arrival', e => toast(`${e.busName} reported at ${e.stopName}`, 'arrival'))
    s.on('audit', items => setAuditFeed(items))
    s.on('refresh', () => setRefreshTick(t => t + 1))
    return () => s.close()
  }, [user?.id])

  if (booting) return <div className="boot">Loading…</div>

  if (!user) {
    return (
      <>
        <LoginPage onLoggedIn={setUser} />
        <Toasts toasts={toasts} />
      </>
    )
  }

  const Page = user.role === 'rider' ? RiderPage : AdminPage
  const initials = user.name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase()

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><BusMark /></span>
          <span className="brand-copy">
            <strong>Campus Seatline</strong>
            <span>Stop-led bus occupancy</span>
          </span>
        </div>
        <div className="who">
          <span className={`connection ${connectionStatus}`} role="status">
            <span className="connection-dot" />
            {connectionStatus === 'live' ? 'Live' : connectionStatus === 'connecting' ? 'Connecting' : 'Reconnecting'}
          </span>
          <span className="avatar" aria-hidden="true">{initials}</span>
          <span className="identity">
            <strong>{user.name}</strong>
            <span>{user.role === 'admin' ? 'Transport admin' : 'Rider'}</span>
          </span>
          <button className="btn quiet logout" onClick={() => { setToken(null); location.reload() }} aria-label="Log out">
            Log out
          </button>
        </div>
      </header>
      <main id="main-content">
        <Page
          user={user}
          toast={toast}
          occupancy={occupancy}
          prompts={prompts}
          notifications={notifications}
          auditFeed={auditFeed}
          refreshTick={refreshTick}
          connectionStatus={connectionStatus}
        />
      </main>
      <Toasts toasts={toasts} />
    </div>
  )
}
