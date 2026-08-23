import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'

const STOP_PAGE_SIZE = 8

function SectionHeading({ eyebrow, title, description, action }) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  )
}

function TimelineEditor({ rows, setRows }) {
  return (
    <fieldset className="field timeline-editor">
      <legend>Expected arrivals</legend>
      <p className="field-help">Add the times riders should expect a bus at this stop.</p>
      {rows.map((r, i) => (
        <div key={i} className="row tight">
          <label><span className="sr-only">Arrival time {i + 1}</span><input type="time" value={r.time} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, time: e.target.value } : x))} /></label>
          <label><span className="sr-only">Arrival label {i + 1}</span><input placeholder="e.g. Morning pickup" value={r.label} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} /></label>
          <button type="button" className="btn icon-btn quiet" aria-label={`Remove arrival ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button type="button" className="btn secondary small" onClick={() => setRows([...rows, { time: '', label: '' }])}>+ Add arrival</button>
    </fieldset>
  )
}

function OrderedStopPicker({ all, value, onChange }) {
  const move = (i, d) => {
    const v = [...value]
    const j = i + d
    if (j < 0 || j >= v.length) return
    ;[v[i], v[j]] = [v[j], v[i]]
    onChange(v)
  }
  const remaining = all.filter(s => !value.includes(s.id))
  return (
    <fieldset className="field ordered-picker">
      <legend>Stop sequence</legend>
      <p className="field-help">Order matters: arrival notices move from left to right.</p>
      <div className="chips">
        {value.map((id, i) => {
          const s = all.find(x => x.id === id)
          return (
            <span key={id} className="chip sel">
              {i + 1}. {s ? s.name : id}
              <button type="button" aria-label={`Move ${s?.name || id} earlier`} onClick={() => move(i, -1)}>↑</button>
              <button type="button" aria-label={`Move ${s?.name || id} later`} onClick={() => move(i, 1)}>↓</button>
              <button type="button" aria-label={`Remove ${s?.name || id}`} onClick={() => onChange(value.filter(x => x !== id))}>×</button>
            </span>
          )
        })}
        {value.length === 0 && <span className="muted">No stops yet</span>}
      </div>
      <select value="" onChange={e => { if (e.target.value) onChange([...value, e.target.value]) }}>
        <option value="">+ Add stop to path…</option>
        {remaining.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </fieldset>
  )
}

function OverviewTab({ data, occupancy }) {
  const occFor = b => occupancy[b.id] || b.occ || {}
  return (
    <section className="card wide admin-section">
      <SectionHeading
        eyebrow="Live operations"
        title="Occupancy by bus"
        description="Seats Occupied is derived from confirmed riders plus any audit-logged Incharge correction."
        action={<span className="sync-pill live"><span />Updating live</span>}
      />
      <div className="table-wrap"><table>
        <thead>
          <tr><th>Bus</th><th>Availability</th><th>Occupied</th><th>Soft Holds</th><th>Capacity</th><th>Correction</th><th>Updated</th></tr>
        </thead>
        <tbody>
          {data.buses.map(b => {
            const o = occFor(b)
            const adj = o.manualAdjustment ?? 0
            const available = o.availableSeats ?? b.capacity
            const state = available === 0 ? 'full' : available / (o.capacity || b.capacity) <= .25 ? 'tight' : 'open'
            return (
              <tr key={b.id}>
                <td><strong className="bus-name-cell">{b.name}</strong><small>{b.stopIds.length} stops</small></td>
                <td><span className={`availability-cell ${state}`}><strong>{available}</strong><span>{state === 'full' ? 'Full' : state === 'tight' ? 'Nearly full' : 'Seats open'}</span></span></td>
                <td>{o.seatsOccupied ?? 0}</td>
                <td>{o.softHolds ?? 0}</td>
                <td>{o.capacity ?? b.capacity}</td>
                <td>{adj ? <span className="status-label warning">{adj > 0 ? `+${adj}` : adj}</span> : <span className="subtle">None</span>}</td>
                <td className="subtle">{o.lastUpdated ? new Date(o.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table></div>
    </section>
  )
}

function StopsTab({ data, reload, toast }) {
  const [name, setName] = useState('')
  const [rows, setRows] = useState([{ time: '', label: '' }])
  const [newBusIds, setNewBusIds] = useState([])
  const [editingId, setEditingId] = useState(null)
  const [busy, setBusy] = useState(false)

  const [query, setQuery] = useState('')
  const [dir, setDir] = useState('az')
  const [incFilter, setIncFilter] = useState('all')
  const [busFilter, setBusFilter] = useState('all')
  const [page, setPage] = useState(0)

  useEffect(() => { setPage(0) }, [query, dir, incFilter, busFilter])

  const coveredByIncharge = useMemo(() => {
    const map = new Map()
    for (const s of data.stops) {
      map.set(s.id, data.assignments.some(a =>
        !a.revokedAt &&
        ((a.scopeType === 'stop' && a.stopId === s.id) ||
          (a.scopeType === 'bus' && data.buses.find(b => b.id === a.busId)?.stopIds.includes(s.id)))
      ))
    }
    return map
  }, [data])

  const filteredStops = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = data.stops.filter(s =>
      !q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
    )
    if (incFilter === 'has') list = list.filter(s => coveredByIncharge.get(s.id))
    if (incFilter === 'none') list = list.filter(s => !coveredByIncharge.get(s.id))
    if (busFilter !== 'all') list = list.filter(s => s.busIds.includes(busFilter))
    list.sort((a, b) => dir === 'az'
      ? a.name.localeCompare(b.name)
      : b.name.localeCompare(a.name))
    return list
  }, [data, query, dir, incFilter, busFilter, coveredByIncharge])

  const pages = Math.max(1, Math.ceil(filteredStops.length / STOP_PAGE_SIZE))
  const safePage = Math.min(page, pages - 1)
  const pageRows = filteredStops.slice(safePage * STOP_PAGE_SIZE, (safePage + 1) * STOP_PAGE_SIZE)

  const create = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api('/admin/stops', { method: 'POST', body: { name, timeline: rows.filter(r => r.time), busIds: newBusIds } })
      setName(''); setRows([{ time: '', label: '' }]); setNewBusIds([])
      toast('Stop created', 'feedback'); reload()
    } catch (e) { toast(e.message, 'error') }
    finally { setBusy(false) }
  }

  const riders = data.users.filter(u => u.role === 'rider')

  return (
    <>
      <details className="card wide admin-section form-section create-disclosure">
        <summary><span><span className="eyebrow">Add to network</span><strong>Create a stop</strong><small>Name it, add expected arrivals, and link buses.</small></span><span className="disclosure-plus" aria-hidden="true">+</span></summary>
        <label className="field-label">Stop name<input placeholder="e.g. Engineering Gate" value={name} onChange={e => setName(e.target.value)} /></label>
        <TimelineEditor rows={rows} setRows={setRows} />
        <fieldset className="field">
          <legend>Linked buses</legend>
          <p className="field-help">You can change these links later.</p>
          <div className="chips">
            {data.buses.map(bus => (
              <button type="button" key={bus.id} aria-pressed={newBusIds.includes(bus.id)} className={newBusIds.includes(bus.id) ? 'chip sel' : 'chip'} onClick={() => setNewBusIds(current => current.includes(bus.id) ? current.filter(id => id !== bus.id) : [...current, bus.id])}>
                <span className="checkmark" aria-hidden="true">✓</span>{bus.name}
              </button>
            ))}
          </div>
        </fieldset>
        <button className="btn primary" disabled={!name.trim() || busy} onClick={create}>{busy ? <><span className="spinner" /> Creating</> : 'Create stop'}</button>
      </details>

      <section className="card wide admin-section list-section">
        <SectionHeading eyebrow="Stop directory" title="Manage stops" description="Find coverage gaps, update timelines, or change linked buses." />
        <div className="controls filter-bar">
          <label className="search-field"><span className="sr-only">Search stops</span><span className="search-icon" aria-hidden="true">⌕</span><input type="search" placeholder="Search stops by name…" value={query} onChange={e => setQuery(e.target.value)} /></label>
          <label><span className="sr-only">Incharge coverage</span><select value={incFilter} onChange={e => setIncFilter(e.target.value)}>
            <option value="all">Incharge: all</option>
            <option value="has">Has Incharge</option>
            <option value="none">No Incharge</option>
          </select></label>
          <label><span className="sr-only">Filter by bus</span><select value={busFilter} onChange={e => setBusFilter(e.target.value)}>
            <option value="all">Bus: all</option>
            {data.buses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select></label>
          <button
            className="btn secondary"
            onClick={() => setDir(d => d === 'az' ? 'za' : 'az')}
            aria-label="Toggle stop name sort direction"
          >
            Name {dir === 'az' ? 'A–Z ↑' : 'Z–A ↓'}
          </button>
        </div>

        <p className="result-count" aria-live="polite"><strong>{filteredStops.length}</strong> stop{filteredStops.length === 1 ? '' : 's'} found</p>

        {pageRows.length === 0 && <div className="empty-inline"><span aria-hidden="true">⌕</span><p>No stops match these filters. Try clearing one filter.</p></div>}

        {pageRows.map(s => (
          editingId === s.id
            ? <EditStop
                key={s.id}
                stop={s}
                buses={data.buses}
                riders={riders}
                assignments={data.assignments}
                reload={reload}
                done={() => { setEditingId(null); reload() }}
                toast={toast}
              />
            : (
              <article key={s.id} className={`stoprow ${coveredByIncharge.get(s.id) ? '' : 'needs-attention'}`}>
                <div className="stoprow-main">
                  <span className="stop-index" aria-hidden="true">{String(safePage * STOP_PAGE_SIZE + pageRows.indexOf(s) + 1).padStart(2, '0')}</span>
                  <span><strong>{s.name}</strong><small>{s.timeline.length ? s.timeline.map(t => t.time).join(' · ') : 'No expected arrivals'} · {s.busIds.length ? `${s.busIds.length} linked bus${s.busIds.length === 1 ? '' : 'es'}` : 'No linked buses'}</small></span>
                  {coveredByIncharge.get(s.id)
                    ? <span className="status-label covered"><span aria-hidden="true">✓</span> Covered</span>
                    : <span className="status-label attention"><span aria-hidden="true">!</span> Needs Incharge</span>}
                </div>
                <button className="btn secondary" onClick={() => setEditingId(s.id)}>Edit stop</button>
              </article>
            )
        ))}

        <div className="pagebar">
          <button className="btn secondary" disabled={safePage === 0} onClick={() => setPage(p => p - 1)}>← Previous</button>
          <span>Page <strong>{safePage + 1}</strong> of {pages}</span>
          <button className="btn secondary" disabled={safePage >= pages - 1} onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      </section>
    </>
  )
}

function EditStop({ stop, buses, riders, assignments, reload, done, toast }) {
  const [name, setName] = useState(stop.name)
  const [rows, setRows] = useState(stop.timeline.length ? stop.timeline : [{ time: '', label: '' }])
  const [busIds, setBusIds] = useState(stop.busIds)
  const [grantRider, setGrantRider] = useState('')
  const [busy, setBusy] = useState('')

  const stopAssignments = assignments.filter(a => a.scopeType === 'stop' && a.stopId === stop.id)

  const save = async () => {
    if (busy) return
    setBusy('save')
    try {
      await api(`/admin/stops/${stop.id}`, {
        method: 'PUT',
        body: { name, timeline: rows.filter(r => r.time), busIds }
      })
      toast('Stop saved', 'feedback'); reload(); done()
    } catch (e) { toast(e.message, 'error') }
    finally { setBusy('') }
  }

  const grant = async () => {
    if (busy) return
    setBusy('grant')
    try {
      await api('/admin/incharge-assignments', {
        method: 'POST',
        body: { riderId: grantRider, scopeType: 'stop', stopId: stop.id }
      })
      toast('Incharge authority granted for this stop', 'feedback')
      setGrantRider('')
      reload()
    } catch (e) { toast(e.message, 'error') }
    finally { setBusy('') }
  }

  const revoke = async id => {
    if (busy) return
    setBusy(`revoke-${id}`)
    try {
      await api(`/admin/incharge-assignments/${id}`, { method: 'DELETE' })
      toast('Authority revoked', 'feedback')
      reload()
    } catch (e) { toast(e.message, 'error') }
    finally { setBusy('') }
  }

  return (
    <section className="card wide editing admin-section">
      <SectionHeading eyebrow="Editing stop" title={stop.name} description="Changes apply immediately to every linked rider view." />
      <label className="field-label">Stop name<input value={name} onChange={e => setName(e.target.value)} /></label>
      <TimelineEditor rows={rows} setRows={setRows} />
      <div className="field">
        <span className="label">Buses serving this stop</span>
        <div className="chips">
          {buses.map(b => (
            <button
              type="button"
              key={b.id}
              aria-pressed={busIds.includes(b.id)}
              className={busIds.includes(b.id) ? 'chip sel' : 'chip'}
              onClick={() => setBusIds(busIds.includes(b.id) ? busIds.filter(x => x !== b.id) : [...busIds, b.id])}
            >
              {b.name}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="label">Incharge authority for this stop</span>
        {stopAssignments.filter(a => !a.revokedAt).map(a => (
          <div key={a.id} className="stoprow">
            <span>{a.riderName} <span className="muted">· since {new Date(a.grantedAt).toLocaleString()}</span></span>
            <button className="btn danger-quiet" disabled={Boolean(busy)} onClick={() => revoke(a.id)}>{busy === `revoke-${a.id}` ? 'Revoking…' : 'Revoke'}</button>
          </div>
        ))}
        {stopAssignments.filter(a => !a.revokedAt).length === 0 && <p className="muted">No active assignment for this stop.</p>}
        <div className="row tight">
          <label className="grow"><span className="sr-only">Rider to grant authority</span><select value={grantRider} onChange={e => setGrantRider(e.target.value)}>
            <option value="">Grant authority to rider…</option>
            {riders.map(r => <option key={r.id} value={r.id}>{r.name} ({r.email})</option>)}
          </select></label>
          <button className="btn secondary" disabled={!grantRider || Boolean(busy)} onClick={grant}>{busy === 'grant' ? <><span className="spinner dark" /> Granting</> : 'Grant authority'}</button>
        </div>
      </div>
      <div className="row">
        <button className="btn primary" disabled={Boolean(busy)} onClick={save}>{busy === 'save' ? <><span className="spinner" /> Saving</> : 'Save changes'}</button>
        <button className="btn secondary" disabled={Boolean(busy)} onClick={done}>Cancel</button>
      </div>
    </section>
  )
}

function BusesTab({ data, reload, toast }) {
  const [editingId, setEditingId] = useState(null)

  return (
    <>
      <NewBus data={data} reload={reload} toast={toast} />
      {data.buses.map(b =>
        editingId === b.id
          ? <EditBus key={b.id} bus={b} data={data} done={() => { setEditingId(null); reload() }} toast={toast} />
          : (
            <article key={b.id} className="card bus-management-card">
              <div className="card-head">
                <div><span className="eyebrow">{b.capacity} seat capacity</span><h2>{b.name}</h2></div>
                <button className="btn secondary" onClick={() => setEditingId(b.id)}>Edit bus</button>
              </div>
              <div className="management-meta">
                {b.inchargeNames.length
                  ? <span className="status-label covered"><span aria-hidden="true">✓</span>{b.inchargeNames.join(', ')}</span>
                  : <span className="status-label attention"><span aria-hidden="true">!</span>No Incharge coverage</span>}
              </div>
              <ol className="route-rail compact">
                {b.stopIds.map((id, index) => {
                  const s = data.stops.find(x => x.id === id)
                  return <li key={id}><span aria-hidden="true" />{s ? s.name : id}<small>Stop {index + 1}</small></li>
                })}
              </ol>
            </article>
          )
      )}
    </>
  )
}

function NewBus({ data, reload, toast }) {
  const [name, setName] = useState('')
  const [capacity, setCapacity] = useState(30)
  const [stopIds, setStopIds] = useState([])
  const [busy, setBusy] = useState(false)

  const create = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api('/admin/buses', { method: 'POST', body: { name, capacity: Number(capacity), stopIds } })
      setName(''); setCapacity(30); setStopIds([])
      toast('Bus created', 'feedback'); reload()
    } catch (e) { toast(e.message, 'error') }
    finally { setBusy(false) }
  }

  return (
    <details className="card wide admin-section form-section create-disclosure">
      <summary><span><span className="eyebrow">Fleet setup</span><strong>Create a bus</strong><small>Set capacity and build its ordered stop sequence.</small></span><span className="disclosure-plus" aria-hidden="true">+</span></summary>
      <div className="form-grid two">
        <label className="field-label">Bus name or number<input placeholder="e.g. Shuttle-03" value={name} onChange={e => setName(e.target.value)} /></label>
        <label className="field-label">Seat capacity<input type="number" min="1" value={capacity} onChange={e => setCapacity(e.target.value)} /></label>
      </div>
      <OrderedStopPicker all={data.stops} value={stopIds} onChange={setStopIds} />
      <p className="field-help">Incharge authority is granted to a rider after the bus is created.</p>
      <button className="btn primary" disabled={!name.trim() || busy} onClick={create}>{busy ? <><span className="spinner" /> Creating</> : 'Create bus'}</button>
    </details>
  )
}

function EditBus({ bus, data, done, toast }) {
  const [name, setName] = useState(bus.name)
  const [capacity, setCapacity] = useState(bus.capacity)
  const [stopIds, setStopIds] = useState(bus.stopIds)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api(`/admin/buses/${bus.id}`, {
        method: 'PUT',
        body: { name, capacity: Number(capacity), stopIds }
      })
      toast('Bus saved', 'feedback'); done()
    } catch (e) { toast(e.message, 'error') }
    finally { setBusy(false) }
  }

  return (
    <section className="card wide editing admin-section">
      <SectionHeading eyebrow="Editing bus" title={bus.name} description="Capacity cannot be reduced below seats that are currently occupied or held." />
      <div className="form-grid two">
        <label className="field-label">Bus name or number<input value={name} onChange={e => setName(e.target.value)} /></label>
        <label className="field-label">Seat capacity<input type="number" min="1" value={capacity} onChange={e => setCapacity(e.target.value)} /></label>
      </div>
      <OrderedStopPicker all={data.stops} value={stopIds} onChange={setStopIds} />
      <p className="field-help">Incharge authority is managed separately in the Incharge section.</p>
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? <><span className="spinner" /> Saving</> : 'Save changes'}</button>
        <button className="btn secondary" disabled={busy} onClick={done}>Cancel</button>
      </div>
    </section>
  )
}

function AssignmentsTab({ data, reload, toast }) {
  const riders = data.users.filter(u => u.role === 'rider')
  const [riderId, setRiderId] = useState('')
  const [scopeType, setScopeType] = useState('bus')
  const [targetId, setTargetId] = useState('')
  const [filter, setFilter] = useState('active')
  const [busy, setBusy] = useState('')

  useEffect(() => { setTargetId('') }, [scopeType])

  const grant = async () => {
    if (busy) return
    setBusy('grant')
    try {
      await api('/admin/incharge-assignments', {
        method: 'POST',
        body: scopeType === 'bus'
          ? { riderId, scopeType, busId: targetId }
          : { riderId, scopeType, stopId: targetId }
      })
      toast('Incharge authority granted', 'feedback')
      setRiderId(''); setTargetId('')
      reload()
    } catch (e) { toast(e.message, 'error') }
    finally { setBusy('') }
  }

  const revoke = async id => {
    if (busy) return
    setBusy(`revoke-${id}`)
    try {
      await api(`/admin/incharge-assignments/${id}`, { method: 'DELETE' })
      toast('Authority revoked', 'feedback')
      reload()
    } catch (e) { toast(e.message, 'error') }
    finally { setBusy('') }
  }

  const visible = data.assignments
    .filter(a => filter === 'all' || !a.revokedAt)
    .sort((a, b) => String(b.grantedAt).localeCompare(String(a.grantedAt)))

  return (
    <>
      <section className="card wide admin-section form-section authority-admin">
        <SectionHeading eyebrow="Rider authority" title="Grant Incharge access" description="Incharge is permission on a rider account—not a separate role or login. Choose exactly what the rider can correct." />
        <div className="form-grid assignment-grid">
          <label className="field-label">Rider<select value={riderId} onChange={e => setRiderId(e.target.value)}>
            <option value="">Rider…</option>
            {riders.map(r => <option key={r.id} value={r.id}>{r.name} ({r.email})</option>)}
          </select></label>
          <label className="field-label">Authority scope<select value={scopeType} onChange={e => setScopeType(e.target.value)}>
            <option value="bus">Bus scope</option>
            <option value="stop">Stop scope</option>
          </select></label>
          <label className="field-label">{scopeType === 'bus' ? 'Bus' : 'Stop'}<select value={targetId} onChange={e => setTargetId(e.target.value)}>
            <option value="">{scopeType === 'bus' ? 'Bus…' : 'Stop…'}</option>
            {(scopeType === 'bus' ? data.buses : data.stops).map(t =>
              <option key={t.id} value={t.id}>{t.name}</option>
            )}
          </select></label>
          <button className="btn authority-action" disabled={!riderId || !targetId || Boolean(busy)} onClick={grant}>{busy === 'grant' ? <><span className="spinner" /> Granting</> : 'Grant authority'}</button>
        </div>
      </section>

      <section className="card wide admin-section list-section">
        <SectionHeading eyebrow="Permission register" title="Incharge assignments" description="Review active authority and its full revocation history." />
        <div className="controls filter-bar compact-bar">
          <label><span className="sr-only">Assignment status</span><select value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="active">Active only</option>
            <option value="all">Include revoked</option>
          </select></label>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>Rider</th><th>Scope</th><th>Granted by</th><th>Granted at</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {visible.map(a => (
              <tr key={a.id}>
                <td>{a.riderName}</td>
                <td>{a.scopeType === 'bus' ? 'Bus' : 'Stop'} · {a.scopeName}</td>
                <td className="muted">{a.grantedByName}</td>
                <td className="muted">{new Date(a.grantedAt).toLocaleString()}</td>
                <td>
                  {a.revokedAt
                    ? <span className="muted">Revoked {new Date(a.revokedAt).toLocaleString()}</span>
                    : <span className="status-label covered"><span aria-hidden="true">✓</span>Active</span>}
                </td>
                <td>
                  {!a.revokedAt && <button className="btn danger-quiet" disabled={Boolean(busy)} onClick={() => revoke(a.id)}>{busy === `revoke-${a.id}` ? 'Revoking…' : 'Revoke'}</button>}
                </td>
              </tr>
            ))}
            {visible.length === 0 && <tr><td colSpan="6" className="subtle">No assignments match this view.</td></tr>}
          </tbody>
        </table></div>
      </section>
    </>
  )
}

function UsersTab({ data }) {
  return (
    <section className="card wide admin-section list-section">
      <SectionHeading eyebrow="Account directory" title="People using Seatline" description="Incharge riders remain riders; their authority is listed separately." />
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Stops</th></tr></thead>
        <tbody>
          {data.users.map(u => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td className="subtle">{u.email}</td>
              <td><span className={`status-label ${u.role === 'admin' ? 'info' : 'covered'}`}>{u.role === 'admin' ? 'Admin' : 'Rider'}</span></td>
              <td>{u.stopNames.join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </section>
  )
}

function AuditTab({ data, auditFeed }) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const merged = Object.values(
    [...(auditFeed || []), ...data.audit].reduce((acc, item) => {
      acc[item.id] = item
      return acc
    }, {})
  ).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
  const visible = merged.filter(item => {
    const matchesKind = kind === 'all' || item.kind === kind
    const haystack = `${item.actor} ${item.detail} ${item.kind}`.toLowerCase()
    return matchesKind && (!query.trim() || haystack.includes(query.trim().toLowerCase()))
  })
  const kinds = [...new Set(merged.map(item => item.kind))]

  return (
    <section className="card wide admin-section list-section">
      <SectionHeading eyebrow="Immutable activity" title="Audit trail" description="Every report attempt—including rejected duplicates—plus arrivals, availability corrections, grants, and revocations." />
      <div className="controls filter-bar">
        <label className="search-field"><span className="sr-only">Search audit trail</span><span className="search-icon" aria-hidden="true">⌕</span><input type="search" placeholder="Search actor or detail…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <label><span className="sr-only">Audit event type</span><select value={kind} onChange={event => setKind(event.target.value)}><option value="all">All event types</option>{kinds.map(item => <option key={item} value={item}>{item.replace(/_/g, ' ')}</option>)}</select></label>
        <span className="result-count"><strong>{visible.length}</strong> events</span>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Time</th><th>Type</th><th>Actor</th><th>Detail</th></tr></thead>
        <tbody>
          {visible.map(item => (
            <tr key={item.id}>
              <td className="subtle audit-time">{new Date(item.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
              <td><span className={`status-label audit-kind ${item.kind}`}>{item.kind.replace(/_/g, ' ')}</span></td>
              <td>{item.actor}</td>
              <td>{item.detail}</td>
            </tr>
          ))}
          {visible.length === 0 && <tr><td colSpan="4" className="subtle">No audit events match this search.</td></tr>}
        </tbody>
      </table></div>
      <p className="privacy-note admin-note"><span aria-hidden="true">◇</span> No reputation scores, trust ratings, or mismatch flags are generated.</p>
    </section>
  )
}

const adminTabs = [
  ['overview', 'Overview'], ['stops', 'Stops'], ['buses', 'Buses'],
  ['incharge', 'Incharge'], ['users', 'Users'], ['audit', 'Audit log']
]

export default function AdminPage({ toast, occupancy, auditFeed, refreshTick, connectionStatus }) {
  const [tab, setTab] = useState('overview')
  const [data, setData] = useState(null)

  const load = () => api('/admin/overview').then(setData).catch(e => toast(e.message, 'error'))
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (refreshTick > 0) load()
  }, [refreshTick])

  if (!data) return <div className="loading-state"><span className="spinner dark" /> Loading transport operations</div>

  const activeAssignments = data.assignments.filter(item => !item.revokedAt).length
  const coveredStops = data.stops.filter(stop => data.assignments.some(assignment =>
    !assignment.revokedAt && ((assignment.scopeType === 'stop' && assignment.stopId === stop.id) ||
      (assignment.scopeType === 'bus' && data.buses.find(bus => bus.id === assignment.busId)?.stopIds.includes(stop.id)))
  )).length
  const totalCapacity = data.buses.reduce((sum, bus) => sum + bus.capacity, 0)

  return (
    <div className="admin-page">
      <header className="page-intro admin-intro">
        <div>
          <p className="eyebrow">Transport operations</p>
          <h1>Network control desk</h1>
          <p className="supporting">Manage stop-led bus service, rider authority, and live seat counts.</p>
        </div>
        <span className={`sync-pill ${connectionStatus}`}><span />{connectionStatus === 'live' ? 'Live data connected' : 'Reconnecting to live data'}</span>
      </header>

      <section className="ops-summary" aria-label="Network summary">
        <div><span className="summary-icon bus" aria-hidden="true">▣</span><span><strong>{data.buses.length}</strong><small>Buses · {totalCapacity} seats</small></span></div>
        <div><span className="summary-icon stop" aria-hidden="true">●</span><span><strong>{data.stops.length}</strong><small>Stops in network</small></span></div>
        <div><span className="summary-icon authority" aria-hidden="true">◇</span><span><strong>{activeAssignments}</strong><small>Active Incharge grants</small></span></div>
        <div className={coveredStops < data.stops.length ? 'attention' : ''}><span className="summary-icon coverage" aria-hidden="true">{coveredStops < data.stops.length ? '!' : '✓'}</span><span><strong>{data.stops.length - coveredStops}</strong><small>Stops need coverage</small></span></div>
      </section>

      <nav className="tabs admin-tabs" role="tablist" aria-label="Admin sections">
        {adminTabs.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'tab active' : 'tab'} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="admin-content grid">
        {tab === 'overview' && <OverviewTab data={data} occupancy={occupancy} />}
        {tab === 'stops' && <StopsTab data={data} reload={load} toast={toast} />}
        {tab === 'buses' && <BusesTab data={data} reload={load} toast={toast} />}
        {tab === 'incharge' && <AssignmentsTab data={data} reload={load} toast={toast} />}
        {tab === 'users' && <UsersTab data={data} />}
        {tab === 'audit' && <AuditTab data={data} auditFeed={auditFeed} />}
      </div>
    </div>
  )
}
