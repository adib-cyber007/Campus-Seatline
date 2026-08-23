import { useEffect, useState } from 'react'
import { api, setToken } from '../api'

export default function LoginPage({ onLoggedIn }) {
  const [mode, setMode] = useState('login')
  const [stops, setStops] = useState([])
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'rider', stopIds: [] })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api('/meta').then(d => setStops(d.stops)).catch(() => {})
  }, [])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const toggleStop = id =>
    set('stopIds', form.stopIds.includes(id) ? form.stopIds.filter(x => x !== id) : [...form.stopIds, id])
  const useDemo = (email, password) => {
    setForm(current => ({ ...current, email, password }))
    setMode('login')
    setError('')
  }

  const submit = async e => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const path = mode === 'login' ? '/auth/login' : '/auth/register'
      const body = mode === 'login'
        ? { email: form.email, password: form.password }
        : {
            name: form.name,
            email: form.email,
            password: form.password,
            role: form.role,
            stopIds: form.stopIds
          }
      const d = await api(path, { method: 'POST', body })
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
            <h2>{mode === 'login' ? 'Sign in to check your bus' : 'Create your rider account'}</h2>
            <p className="supporting">{mode === 'login' ? 'Live availability is one tap away.' : 'Choose your stop and we’ll find the buses that serve it.'}</p>
          </div>
          <div className="tabs auth-tabs" role="tablist" aria-label="Account action">
            <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'tab active' : 'tab'} onClick={() => { setMode('login'); setError('') }}>Sign in</button>
            <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'tab active' : 'tab'} onClick={() => { setMode('register'); setError('') }}>Register</button>
          </div>
          {mode === 'register' && (
            <label>Full name<input required autoComplete="name" value={form.name} onChange={e => set('name', e.target.value)} /></label>
          )}
          <label>Email address<input required autoComplete="email" type="email" value={form.email} onChange={e => set('email', e.target.value)} /></label>
          <label>Password<input required minLength="6" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} type="password" value={form.password} onChange={e => set('password', e.target.value)} /></label>
          {mode === 'register' && (
            <>
              <fieldset className="field stop-picker">
                <legend>My stop(s)</legend>
                <p className="field-help">Select every stop you regularly use.</p>
                <div className="chips">
                  {stops.map(s => (
                    <button
                      type="button"
                      key={s.id}
                      aria-pressed={form.stopIds.includes(s.id)}
                      className={form.stopIds.includes(s.id) ? 'chip sel' : 'chip'}
                      onClick={() => toggleStop(s.id)}
                    >
                      <span className="checkmark" aria-hidden="true">✓</span>{s.name}
                    </button>
                  ))}
                </div>
              </fieldset>
              <p className="privacy-note"><span aria-hidden="true">◇</span> You’re creating a rider account. Incharge access is granted to that same account by an admin.</p>
            </>
          )}
          {error && <p className="error callout" role="alert">{error}</p>}
          <button className="btn primary block large" disabled={busy}>
            {busy ? <><span className="spinner" /> Please wait</> : mode === 'login' ? 'Sign in' : 'Create rider account'}
          </button>
          {mode === 'login' && (
            <div className="seed">
              <span className="seed-label">Try a demo account</span>
              <div className="demo-accounts">
                <button type="button" onClick={() => useDemo('rider@campus.edu', 'rider123')}><strong>Rider</strong><span>Main Gate</span></button>
                <button type="button" onClick={() => useDemo('incharge@campus.edu', 'incharge123')}><strong>Rider + Incharge</strong><span>Shuttle-01</span></button>
                <button type="button" onClick={() => useDemo('admin@campus.edu', 'admin123')}><strong>Admin</strong><span>Transport office</span></button>
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  )
}
