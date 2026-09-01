import { useState } from 'react'
import { api, getApiOrigin, isNativeApp, setApiOrigin, setToken } from '../api'

export default function LoginPage({ onLoggedIn }) {
  const [form, setForm] = useState({ email: '', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [serverUrl, setServerUrl] = useState(() => getApiOrigin())
  const [serverBusy, setServerBusy] = useState(false)
  const [serverNotice, setServerNotice] = useState('')
  const nativeApp = isNativeApp()

  const saveServer = async () => {
    setError('')
    setServerNotice('')
    setServerBusy(true)
    try {
      const saved = setApiOrigin(serverUrl)
      setServerUrl(saved)
      setToken(null)
      await api('/meta')
      setServerNotice(saved ? 'Connected. You can sign in now.' : 'Using this website’s server.')
    } catch (err) {
      setError(err.message === 'Failed to fetch' ? 'Could not reach that server. Check the address and connection.' : err.message)
    } finally {
      setServerBusy(false)
    }
  }

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const useDemo = (email, password) => {
    setForm(current => ({ ...current, email, password }))
    setError('')
  }

  const submit = async e => {
    e.preventDefault()
    setError('')
    if (nativeApp && !getApiOrigin()) {
      setError('Set the Campus Seatline server address before signing in.')
      return
    }
    setBusy(true)
    try {
      const d = await api('/auth/login', {
        method: 'POST', body: { email: form.email, password: form.password }
      })
      setToken(d.token)
      onLoggedIn(d.user)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-stage">
        <aside className="auth-story">
          <div className="auth-wordmark"><span className="mini-bus" aria-hidden="true" /> Campus Seatline</div>
          <div>
            <p className="eyebrow light">Campus rides, without the guesswork</p>
            <h1>Know if there’s room before the bus reaches your stop.</h1>
            <p>Live seat reports from riders. No maps, no GPS, no continuous location tracking.</p>
          </div>
          <div className="story-route" aria-hidden="true">
            <span className="done">Main Gate</span>
            <span>Library Block</span>
            <span>Hostel Circle</span>
          </div>
        </aside>

        <form className="card auth" onSubmit={submit}>
          <div className="auth-heading">
            <p className="eyebrow">Welcome to Seatline</p>
            <h2>Sign in to check your bus</h2>
            <p className="supporting">Live availability is one tap away. Accounts are issued by your transport office.</p>
          </div>
          <details className="server-settings" open={nativeApp && !getApiOrigin()}>
            <summary>Server connection</summary>
            <div className="server-settings-body">
              <label>
                Campus Seatline server
                <input
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  placeholder="https://seatline.example.edu"
                  value={serverUrl}
                  onChange={e => setServerUrl(e.target.value)}
                  aria-describedby="server-help"
                />
              </label>
              <p id="server-help" className="field-help">Use the public or campus-network address of the running backend. Do not add <code>/api</code>.</p>
              <button type="button" className="btn secondary block" disabled={serverBusy} onClick={saveServer}>
                {serverBusy ? <><span className="spinner" /> Testing connection</> : 'Save and test connection'}
              </button>
              {serverNotice && <p className="success-note" role="status">✓ {serverNotice}</p>}
            </div>
          </details>
          <label>Email address<input required autoComplete="email" type="email" value={form.email} onChange={e => set('email', e.target.value)} /></label>
          <label>Password<input required minLength="6" autoComplete="current-password" type="password" value={form.password} onChange={e => set('password', e.target.value)} /></label>
          <p className="privacy-note"><span aria-hidden="true">◇</span> Need access? Ask the transport office to create or update your account.</p>
          {error && <p className="error callout" role="alert">{error}</p>}
          <button className="btn primary block large" disabled={busy}>
            {busy ? <><span className="spinner" /> Please wait</> : 'Sign in'}
          </button>
          <div className="seed">
              <span className="seed-label">Try a demo account</span>
              <div className="demo-accounts">
                <button type="button" onClick={() => useDemo('rider@campus.edu', 'rider123')}><strong>Rider</strong><span>Main Gate</span></button>
                <button type="button" onClick={() => useDemo('incharge@campus.edu', 'incharge123')}><strong>Rider + Incharge</strong><span>Shuttle-01</span></button>
                <button type="button" onClick={() => useDemo('admin@campus.edu', 'admin123')}><strong>Admin</strong><span>Transport office</span></button>
              </div>
          </div>
        </form>
      </div>
    </div>
  )
}
