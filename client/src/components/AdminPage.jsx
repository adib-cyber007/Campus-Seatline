import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { DEFAULT_BEACON_MIN_RSSI, startServiceUuidScan, supportsNativeBeaconScan } from '../bleScanner'
import { campusDateKey, formatCampusDateTime, formatCampusTime } from '../time'
import RiderManifestDialog from './RiderManifestDialog'

const STOP_PAGE_SIZE = 8

function SectionHeading({ eyebrow, title, description, action }) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow && <span className="section-context">{eyebrow}</span>}
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  )
}

function RouteLine({ stopIds, stops, label }) {
  return (
    <ol className="table-route-line" aria-label={`${label} stop sequence`}>
      {stopIds.map(stopId => (
        <li key={stopId}>
          <span aria-hidden="true" />
          {stops.find(stop => stop.id === stopId)?.name || stopId}
        </li>
      ))}
    </ol>
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

function OverviewTab({ data, occupancy, onShowManifest }) {
  const occFor = b => occupancy[b.id] || b.occ || {}
  return (
    <section className="card wide admin-section">
      <SectionHeading
        eyebrow="Current service"
        title="Occupancy by bus"
        description="Seats Occupied is derived from confirmed riders plus any audit-logged Incharge correction."
      />
      <div className="table-wrap"><table>
        <thead>
          <tr><th>Bus</th><th>Trip</th><th>Availability</th><th>Occupied</th><th>Soft Holds</th><th>Capacity</th><th>Correction</th><th>Updated</th></tr>
        </thead>
        <tbody>
          {data.buses.map(b => {
            const o = occFor(b)
            const adj = o.manualAdjustment ?? 0
            const tripActive = o.tripStatus === 'active'
            const available = tripActive ? (o.availableSeats ?? b.capacity) : null
            const state = available === 0 ? 'full' : available !== null && available / (o.capacity || b.capacity) <= .25 ? 'tight' : 'open'
            const path = o.stopSequence?.length ? o.stopSequence : b.stopIds
            return (
              <tr key={b.id}>
                <td className="bus-route-cell"><strong className="bus-name-cell">{b.name}</strong><RouteLine stopIds={path} stops={data.stops} label={`${b.name} ${o.tripDirection || ''}`} /></td>
                <td><strong className="trip-direction">{o.tripDirection || 'No trip'}</strong><small>{o.tripStatus === 'active' ? `${o.tripDate} · in service` : o.tripStatus === 'scheduled' ? `${o.tripDate} · scheduled` : 'Not scheduled today'}</small></td>
                <td className="numeric-cell">{tripActive ? <span className={`availability-cell ${state}`}><strong>{available}</strong><span>{state === 'full' ? 'Full' : state === 'tight' ? 'Nearly full' : 'Seats open'}</span></span> : <span className="subtle">—</span>}</td>
                <td className="numeric-cell">{tripActive ? <button type="button" className="count-manifest-link" aria-label={`View ${b.name} occupied riders`} onClick={() => onShowManifest(b, 'seats_occupied')}>{o.seatsOccupied ?? 0}</button> : (o.seatsOccupied ?? 0)}</td>
                <td className="numeric-cell">{tripActive ? <button type="button" className="count-manifest-link" aria-label={`View ${b.name} Soft Hold riders`} onClick={() => onShowManifest(b, 'soft_hold')}>{o.softHolds ?? 0}</button> : (o.softHolds ?? 0)}</td>
                <td className="numeric-cell">{o.capacity ?? b.capacity}</td>
                <td>{adj ? <span className="status-label warning">{adj > 0 ? `+${adj}` : adj}</span> : <span className="subtle">None</span>}</td>
                <td className="subtle numeric-cell">{o.lastUpdated ? formatCampusTime(o.lastUpdated, data.campusTimeZone) : '—'}</td>
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
        <summary><span><span className="section-context">Network setup</span><strong>Create a stop</strong><small>Name it, add expected arrivals, and link buses.</small></span><span className="disclosure-plus" aria-hidden="true">+</span></summary>
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
                  <span className="rider-count" aria-label={`${s.riderCount} riders counted at ${s.name}`}>
                    <strong>{s.riderCount}</strong> rider{s.riderCount === 1 ? '' : 's'}
                  </span>
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
  const remove = async () => {
    if (busy || !window.confirm(`Remove ${stop.name} from the active network? Historical reports and audit records will be preserved.`)) return
    setBusy('remove')
    try {
      await api(`/admin/stops/${stop.id}`, { method: 'DELETE' })
      toast('Stop removed from the active network; history preserved', 'feedback')
      done()
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
            <span>{a.riderName} <span className="muted">· since {formatCampusDateTime(a.grantedAt, data.campusTimeZone)}</span></span>
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
      <div className="row edit-actions">
        <button className="btn primary" disabled={Boolean(busy)} onClick={save}>{busy === 'save' ? <><span className="spinner" /> Saving</> : 'Save changes'}</button>
        <button className="btn secondary" disabled={Boolean(busy)} onClick={done}>Cancel</button>
        <button className="btn danger-quiet remove-entity" disabled={Boolean(busy)} onClick={remove}>{busy === 'remove' ? 'Removing…' : 'Remove stop'}</button>
      </div>
    </section>
  )
}

function BeaconPassport({ beacon }) {
  return (
    <div className="beacon-passport admin-beacon" aria-label="Server-assigned bus beacon identity">
      <span>Bus beacon · server assigned</span>
      <code>{beacon?.serviceUuid?.toUpperCase() || 'Not assigned'}</code>
      {beacon && <small>Legacy BLE · {beacon.advertisingIntervalMs} ms · {beacon.active ? 'Active' : 'Inactive'}</small>}
    </div>
  )
}

function AdminBeaconTester({ buses, toast }) {
  const [busId, setBusId] = useState('')
  const [controller, setController] = useState(null)
  const [message, setMessage] = useState('Choose one bus to verify its configured transmitter.')
  const selected = buses.find(bus => bus.id === busId)

  const stop = async (nextMessage = 'Beacon test stopped') => {
    await controller?.stop()
    setController(null)
    setMessage(nextMessage)
  }
  const start = async () => {
    if (!selected || controller) return
    if (!supportsNativeBeaconScan()) {
      toast('Admin beacon testing is available in the Android APK', 'info')
      return
    }
    setMessage(`Scanning for ${selected.name}…`)
    try {
      let nextController
      nextController = await startServiceUuidScan({
        beacons: [{ busId: selected.id }],
        minRssi: DEFAULT_BEACON_MIN_RSSI,
        timeoutMs: 30000,
        onDetected: detection => {
          setMessage(`${selected.name} detected at RSSI ${detection.rssi} dBm`)
          toast(`${selected.name} beacon detected`, 'feedback')
          void nextController?.dispose()
          setController(null)
        },
        onState: event => {
          if (event.state === 'timed_out') {
            setMessage(`${selected.name} was not detected within 30 seconds`)
            void nextController?.dispose()
            setController(null)
          }
        }
      })
      setController(nextController)
    } catch (error) {
      setMessage(error.message)
      toast(error.message, 'error')
    }
  }

  return (
    <section className="card wide admin-section admin-beacon-tester">
      <SectionHeading eyebrow="Admin-only hardware check" title="Beacon tester" description="Select the bus represented by the transmitter. Raw identities remain confined to transport Admin views." />
      <div className="form-grid two">
        <label className="field-label">Beacon represents<select value={busId} disabled={Boolean(controller)} onChange={event => setBusId(event.target.value)}><option value="">Choose a bus…</option>{buses.map(bus => <option value={bus.id} key={bus.id}>{bus.name}</option>)}</select></label>
        <div className="row">
          {controller
            ? <button className="btn secondary" onClick={() => stop()}>Stop test</button>
            : <button className="btn primary" disabled={!busId} onClick={start}>Test selected beacon</button>}
        </div>
      </div>
      {selected && <BeaconPassport beacon={selected.beacon} />}
      <p className="beacon-scan-status" role="status" aria-live="polite"><span aria-hidden="true">○</span>{message}</p>
    </section>
  )
}
function BusesTab({ data, reload, toast }) {
  const [editingId, setEditingId] = useState(null)

  return (
    <>
      <NewBus data={data} reload={reload} toast={toast} />
      <AdminBeaconTester buses={data.buses} toast={toast} />
      {data.buses.map(b =>
        editingId === b.id
          ? <EditBus key={b.id} bus={b} data={data} done={() => { setEditingId(null); reload() }} toast={toast} />
          : (
            <article key={b.id} className="card bus-management-card">
              <div className="card-head">
                <div><span className="capacity-label">{b.capacity} seat capacity</span><h2>{b.name}</h2></div>
                <button className="btn secondary" onClick={() => setEditingId(b.id)}>Edit bus</button>
              </div>
              <div className="management-meta">
                <span className="service-times"><strong>{b.morningStartTime}</strong> morning <span aria-hidden="true">/</span> <strong>{b.eveningStartTime}</strong> evening</span>
                {b.inchargeNames.length
                  ? <span className="status-label covered"><span aria-hidden="true">✓</span>{b.inchargeNames.join(', ')}</span>
                  : <span className="status-label attention"><span aria-hidden="true">!</span>No Incharge coverage</span>}
              </div>
              <BeaconPassport beacon={b.beacon} />
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
  const [morningStartTime, setMorningStartTime] = useState('07:00')
  const [eveningStartTime, setEveningStartTime] = useState('17:00')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api('/admin/buses', {
        method: 'POST', body: { name, capacity: Number(capacity), stopIds, morningStartTime, eveningStartTime }
      })
      setName(''); setCapacity(30); setStopIds([])
      toast('Bus created', 'feedback'); reload()
    } catch (e) { toast(e.message, 'error') }
    finally { setBusy(false) }
  }

  return (
    <details className="card wide admin-section form-section create-disclosure">
      <summary><span><span className="section-context">Fleet setup</span><strong>Create a bus</strong><small>Set capacity and build its ordered stop sequence.</small></span><span className="disclosure-plus" aria-hidden="true">+</span></summary>
      <div className="form-grid two">
        <label className="field-label">Bus name or number<input placeholder="e.g. Shuttle-03" value={name} onChange={e => setName(e.target.value)} /></label>
        <label className="field-label">Seat capacity<input type="number" min="1" value={capacity} onChange={e => setCapacity(e.target.value)} /></label>
      </div>
      <div className="form-grid two trip-time-fields">
        <label className="field-label">Morning trip starts<input type="time" value={morningStartTime} onChange={e => setMorningStartTime(e.target.value)} /></label>
        <label className="field-label">Evening trip starts<input type="time" value={eveningStartTime} onChange={e => setEveningStartTime(e.target.value)} /></label>
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
  const [morningStartTime, setMorningStartTime] = useState(bus.morningStartTime || '07:00')
  const [eveningStartTime, setEveningStartTime] = useState(bus.eveningStartTime || '17:00')
  const [busy, setBusy] = useState('')

  const save = async () => {
    if (busy) return
    setBusy('save')
    try {
      await api(`/admin/buses/${bus.id}`, {
        method: 'PUT',
        body: { name, capacity: Number(capacity), stopIds, morningStartTime, eveningStartTime }
      })
      toast('Bus saved', 'feedback'); done()
    } catch (e) { toast(e.message, 'error') }
    finally { setBusy('') }
  }

  const remove = async () => {
    if (busy || !window.confirm(`Remove ${bus.name} from the active network? Historical reports and audit records will be preserved.`)) return
    setBusy('remove')
    try {
      await api(`/admin/buses/${bus.id}`, { method: 'DELETE' })
      toast('Bus removed from the active network; history preserved', 'feedback')
      done()
    } catch (e) { toast(e.message, 'error') }
    finally { setBusy('') }
  }
  return (
    <section className="card wide editing admin-section">
      <SectionHeading eyebrow="Editing bus" title={bus.name} description="Capacity cannot be reduced below seats that are currently occupied or held." />
      <div className="form-grid two">
        <label className="field-label">Bus name or number<input value={name} onChange={e => setName(e.target.value)} /></label>
        <label className="field-label">Seat capacity<input type="number" min="1" value={capacity} onChange={e => setCapacity(e.target.value)} /></label>
      </div>
      <div className="form-grid two trip-time-fields">
        <label className="field-label">Morning trip starts<input type="time" value={morningStartTime} onChange={e => setMorningStartTime(e.target.value)} /></label>
        <label className="field-label">Evening trip starts<input type="time" value={eveningStartTime} onChange={e => setEveningStartTime(e.target.value)} /></label>
      </div>
      <BeaconPassport beacon={bus.beacon} />
      <OrderedStopPicker all={data.stops} value={stopIds} onChange={setStopIds} />
      <p className="field-help">Incharge authority is managed separately in the Incharge section.</p>
      <div className="row edit-actions">
        <button className="btn primary" disabled={Boolean(busy)} onClick={save}>{busy === 'save' ? <><span className="spinner" /> Saving</> : 'Save changes'}</button>
        <button className="btn secondary" disabled={Boolean(busy)} onClick={done}>Cancel</button>
        <button className="btn danger-quiet remove-entity" disabled={Boolean(busy)} onClick={remove}>{busy === 'remove' ? 'Removing…' : 'Remove bus'}</button>
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
                <td className="muted">{formatCampusDateTime(a.grantedAt, data.campusTimeZone)}</td>
                <td>
                  {a.revokedAt
                    ? <span className="muted">Revoked {formatCampusDateTime(a.revokedAt, data.campusTimeZone)}</span>
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

function UsersTab({ data, reload, toast }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'rider', stopIds: [] })
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }))
  const toggleStop = id => set('stopIds', form.stopIds.includes(id)
    ? form.stopIds.filter(stopId => stopId !== id)
    : [...form.stopIds, id])
  const activeAuthority = riderId => data.assignments.filter(item =>
    item.riderId === riderId && !item.revokedAt
  ).length
  const visibleUsers = data.users.filter(user => {
    const text = `${user.name} ${user.email} ${user.role} ${user.stopNames.join(' ')}`.toLowerCase()
    return text.includes(query.trim().toLowerCase())
  })

  const create = async event => {
    event.preventDefault()
    if (busy) return
    setBusy('create')
    try {
      await api('/admin/users', { method: 'POST', body: form })
      toast(`${form.role === 'admin' ? 'Admin' : 'Rider'} account created`, 'feedback')
      setForm({ name: '', email: '', password: '', role: 'rider', stopIds: [] })
      reload()
    } catch (error) { toast(error.message, 'error') }
    finally { setBusy('') }
  }

  const remove = async user => {
    const authorityCount = activeAuthority(user.id)
    const authorityNote = authorityCount
      ? ` ${authorityCount} active Incharge grant${authorityCount === 1 ? '' : 's'} will be revoked.`
      : ''
    if (busy || !window.confirm(
      `Remove ${user.name}'s account?${authorityNote} Historical reports and audit records will be preserved. Active trip reports must be resolved first.`
    )) return
    setBusy(`remove-${user.id}`)
    try {
      const result = await api(`/admin/users/${user.id}`, { method: 'DELETE' })
      const revoked = result.revokedAssignmentIds?.length || 0
      toast(`Account removed${revoked ? ` and ${revoked} Incharge grant${revoked === 1 ? '' : 's'} revoked` : ''}`, 'feedback')
      reload()
    } catch (error) { toast(error.message, 'error') }
    finally { setBusy('') }
  }

  return (
    <>
      <details className="card wide admin-section form-section create-disclosure account-create">
        <summary><span><span className="section-context">Account setup</span><strong>Create an account</strong><small>Set an initial password for a Rider or transport Admin.</small></span><span className="disclosure-plus" aria-hidden="true">+</span></summary>
        <form onSubmit={create}>
          <div className="form-grid account-grid">
            <label className="field-label">Full name<input required autoComplete="off" value={form.name} onChange={event => set('name', event.target.value)} /></label>
            <label className="field-label">Email address<input required type="email" autoComplete="off" value={form.email} onChange={event => set('email', event.target.value)} /></label>
            <label className="field-label">Initial password<input required type="password" minLength="6" autoComplete="new-password" value={form.password} onChange={event => set('password', event.target.value)} /></label>
            <label className="field-label">Account type<select value={form.role} onChange={event => set('role', event.target.value)}><option value="rider">Rider</option><option value="admin">Admin</option></select></label>
          </div>
          {form.role === 'rider' && (
            <fieldset className="field account-stops">
              <legend>Registered stop(s)</legend>
              <p className="field-help">Choose every stop this rider regularly uses.</p>
              <div className="chips">
                {data.stops.map(stop => <button type="button" key={stop.id} aria-pressed={form.stopIds.includes(stop.id)} className={form.stopIds.includes(stop.id) ? 'chip sel' : 'chip'} onClick={() => toggleStop(stop.id)}><span className="checkmark" aria-hidden="true">✓</span>{stop.name}</button>)}
              </div>
            </fieldset>
          )}
          <div className="account-create-action">
            <p><span aria-hidden="true">◇</span> Incharge remains an authority granted later to a Rider account.</p>
            <button className="btn primary" disabled={Boolean(busy) || (form.role === 'rider' && form.stopIds.length === 0)}>{busy === 'create' ? <><span className="spinner" /> Creating</> : 'Create account'}</button>
          </div>
        </form>
      </details>

      <section className="card wide admin-section list-section identity-ledger">
        <SectionHeading eyebrow="Identity ledger" title="Seatline accounts" description="Search active accounts and retire access without erasing operational history." />
        <div className="controls filter-bar compact-bar">
          <label className="search-field"><span className="sr-only">Search accounts</span><span className="search-icon" aria-hidden="true">⌕</span><input type="search" placeholder="Search name, email, stop, or role…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        </div>
        <p className="result-count" aria-live="polite"><strong>{visibleUsers.length}</strong> active account{visibleUsers.length === 1 ? '' : 's'}</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Identity</th><th>Access</th><th>Registered stops</th><th>Incharge</th><th></th></tr></thead>
          <tbody>
            {visibleUsers.map(user => {
              const authorityCount = activeAuthority(user.id)
              return (
                <tr key={user.id}>
                  <td><strong>{user.name}</strong><small>{user.email}</small></td>
                  <td><span className={`status-label ${user.role === 'admin' ? 'info' : 'covered'}`}>{user.role === 'admin' ? 'Admin' : 'Rider'}</span></td>
                  <td>{user.stopNames.join(', ') || <span className="subtle">Transport-wide</span>}</td>
                  <td>{authorityCount ? <span className="status-label authority">{authorityCount} active</span> : <span className="subtle">None</span>}</td>
                  <td><button className="btn danger-quiet" disabled={Boolean(busy)} onClick={() => remove(user)}>{busy === `remove-${user.id}` ? 'Removing…' : 'Remove'}</button></td>
                </tr>
              )
            })}
            {visibleUsers.length === 0 && <tr><td colSpan="5"><div className="empty-inline"><span aria-hidden="true">⌕</span><p>No active accounts match this search.</p></div></td></tr>}
          </tbody>
        </table></div>
      </section>
    </>
  )
}

const weekdayOptions = [
  [1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'],
  [5, 'Friday'], [6, 'Saturday'], [7, 'Sunday']
]

function ScheduleTab({ data, reload, toast }) {
  const [serviceWeekdays, setServiceWeekdays] = useState(data.operatingCalendar?.serviceWeekdays || [1, 2, 3, 4, 5])
  const [exceptions, setExceptions] = useState(data.operatingCalendar?.exceptions || [])
  const [busy, setBusy] = useState(false)
  const today = campusDateKey(new Date(), data.campusTimeZone)
  const todayTrips = (data.trips || []).filter(trip => trip.date === today)

  useEffect(() => {
    setServiceWeekdays(data.operatingCalendar?.serviceWeekdays || [1, 2, 3, 4, 5])
    setExceptions(data.operatingCalendar?.exceptions || [])
  }, [data.operatingCalendar])

  const toggleWeekday = day => setServiceWeekdays(current =>
    current.includes(day) ? current.filter(item => item !== day) : [...current, day].sort((a, b) => a - b)
  )
  const addException = () => setExceptions(current => [
    ...current,
    { date: '', service: false, note: '' }
  ])
  const updateException = (index, patch) => setExceptions(current =>
    current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)
  )
  const removeException = index => setExceptions(current => current.filter((_, itemIndex) => itemIndex !== index))
  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api('/admin/operating-calendar', {
        method: 'PUT',
        body: {
          serviceWeekdays,
          exceptions: exceptions.map(item => ({ date: item.date, service: item.service, note: item.note }))
        }
      })
      toast('Operating Calendar saved', 'feedback')
      reload()
    } catch (error) { toast(error.message, 'error') }
    finally { setBusy(false) }
  }

  return (
    <>
      <section className="card wide admin-section schedule-board">
        <SectionHeading
          eyebrow="Today’s dispatch board"
          title="Morning and evening trips"
          description="Trips activate from each bus clock. Reaching the final stop is never used as an activation gate."
        />
        <div className="table-wrap"><table>
          <thead><tr><th>Bus</th><th>Direction</th><th>Start</th><th>Status</th><th>Stop sequence</th><th>Boarding stops</th></tr></thead>
          <tbody>
            {todayTrips.map(trip => {
              const bus = data.buses.find(item => item.id === trip.busId)
              const start = trip.direction === 'morning' ? bus?.morningStartTime : bus?.eveningStartTime
              return (
                <tr key={trip.id}>
                  <td><strong>{trip.busName}</strong></td>
                  <td><span className={`trip-direction ${trip.direction}`}>{trip.direction}</span></td>
                  <td className="numeric-cell">{start || '—'}</td>
                  <td><span className={`trip-state ${trip.status}`}>{trip.status.replace('_', ' ')}</span></td>
                  <td><RouteLine stopIds={trip.stopSequence} stops={data.stops} label={`${trip.busName} ${trip.direction}`} /></td>
                  <td>{trip.boardingStopNames.join(', ') || <span className="subtle">None</span>}</td>
                </tr>
              )
            })}
            {todayTrips.length === 0 && <tr><td colSpan="6"><div className="empty-inline"><span aria-hidden="true">○</span><p>No trips scheduled today.</p></div></td></tr>}
          </tbody>
        </table></div>
      </section>

      <section className="card wide admin-section calendar-editor">
        <SectionHeading
          eyebrow="Service-day rules"
          title="Operating Calendar"
          description="The weekly pattern decides which dates generate trips. Exceptions override one date for holidays and makeup days."
        />
        <fieldset className="weekday-picker">
          <legend>Default service days</legend>
          {weekdayOptions.map(([day, label]) => (
            <label key={day} className={serviceWeekdays.includes(day) ? 'selected' : ''}>
              <input type="checkbox" checked={serviceWeekdays.includes(day)} onChange={() => toggleWeekday(day)} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>

        <div className="calendar-exceptions">
          <div className="calendar-exceptions-head">
            <div><h3>Date exceptions</h3><p>Force service on or off for a specific date.</p></div>
            <button type="button" className="btn secondary" onClick={addException}>Add date</button>
          </div>
          {exceptions.map((item, index) => (
            <div className="calendar-exception-row" key={`${item.date}-${index}`}>
              <label className="field-label">Date<input type="date" value={item.date} onChange={event => updateException(index, { date: event.target.value })} /></label>
              <label className="field-label">Service<select value={item.service ? 'on' : 'off'} onChange={event => updateException(index, { service: event.target.value === 'on' })}><option value="off">No service</option><option value="on">Run service</option></select></label>
              <label className="field-label exception-note">Reason<input value={item.note || ''} placeholder="Holiday or makeup day" onChange={event => updateException(index, { note: event.target.value })} /></label>
              <button type="button" className="btn danger-quiet" aria-label={`Remove exception ${item.date || index + 1}`} onClick={() => removeException(index)}>Remove</button>
            </div>
          ))}
          {exceptions.length === 0 && <div className="empty-inline"><span aria-hidden="true">○</span><p>No date exceptions configured.</p></div>}
        </div>
        <button className="btn primary calendar-save" disabled={busy || exceptions.some(item => !item.date)} onClick={save}>{busy ? <><span className="spinner" /> Saving</> : 'Save Operating Calendar'}</button>
      </section>
    </>
  )
}

function UnmetDemandTab({ data }) {
  const today = campusDateKey(new Date(), data.campusTimeZone)
  const [dateFrom, setDateFrom] = useState(today)
  const [dateTo, setDateTo] = useState(today)
  const [stopId, setStopId] = useState('all')
  const [busId, setBusId] = useState('all')
  const [direction, setDirection] = useState('all')
  const [status, setStatus] = useState('all')
  const [sort, setSort] = useState('stranded')
  const events = data.unmetDemand?.events || []
  const stopOptions = useMemo(() => {
    const options = new Map(data.stops.map(stop => [stop.id, stop.name]))
    for (const event of events) options.set(event.stopId, event.stopName)
    return [...options].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [data.stops, events])
  const busOptions = useMemo(() => {
    const options = new Map(data.buses.map(bus => [bus.id, bus.name]))
    for (const event of events) options.set(event.busId, event.busName)
    return [...options].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [data.buses, events])

  const filteredEvents = useMemo(() => events.filter(event => {
    if (dateFrom && event.tripDate < dateFrom) return false
    if (dateTo && event.tripDate > dateTo) return false
    if (stopId !== 'all' && event.stopId !== stopId) return false
    if (busId !== 'all' && event.busId !== busId) return false
    if (direction !== 'all' && event.tripDirection !== direction) return false
    if (status === 'stranded' && event.hadAlternateBus) return false
    if (status === 'alternative' && !event.hadAlternateBus) return false
    return true
  }), [events, dateFrom, dateTo, stopId, busId, direction, status])

  const groups = useMemo(() => {
    const grouped = new Map()
    for (const event of filteredEvents) {
      const key = `${event.tripDate}:${event.tripDirection}:${event.stopId}:${event.busId}`
      const group = grouped.get(key) || {
        key, stopId: event.stopId, stopName: event.stopName,
        busId: event.busId, busName: event.busName, events: [],
        tripDate: event.tripDate, tripDirection: event.tripDirection || 'morning',
        strandedCount: 0, alternativeCount: 0, latestAt: event.timestamp
      }
      group.events.push(event)
      if (event.hadAlternateBus) group.alternativeCount += 1
      else group.strandedCount += 1
      if (String(event.timestamp) > String(group.latestAt)) group.latestAt = event.timestamp
      grouped.set(key, group)
    }
    const rows = [...grouped.values()]
    for (const group of rows) group.events.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    rows.sort((a, b) => {
      if (sort === 'latest') return String(b.latestAt).localeCompare(String(a.latestAt))
      if (sort === 'volume') return b.events.length - a.events.length || b.strandedCount - a.strandedCount
      return b.strandedCount - a.strandedCount || b.events.length - a.events.length || String(b.latestAt).localeCompare(String(a.latestAt))
    })
    return rows
  }, [filteredEvents, sort])

  const strandedTotal = filteredEvents.filter(event => !event.hadAlternateBus).length
  return (
    <section className="card wide admin-section list-section unmet-demand" aria-label="Unmet demand">
      <SectionHeading
        eyebrow="Capacity exceptions"
        title="Where seats ran out"
        description="Review capacity rejections by stop and bus. Stranded riders had no other viable bus with a seat at that moment."
        action={<span className={`status-label ${strandedTotal ? 'stranded' : 'covered'}`}><span aria-hidden="true">{strandedTotal ? '!' : '✓'}</span>{strandedTotal} stranded</span>}
      />
      <div className="controls filter-bar demand-filter-bar">
        <label className="dated-filter"><span>From</span><input type="date" value={dateFrom} max={dateTo || undefined} onChange={event => setDateFrom(event.target.value)} /></label>
        <label className="dated-filter"><span>To</span><input type="date" value={dateTo} min={dateFrom || undefined} onChange={event => setDateTo(event.target.value)} /></label>
        <label><span className="sr-only">Filter unmet demand by stop</span><select value={stopId} onChange={event => setStopId(event.target.value)}>
          <option value="all">Stop: all</option>
          {stopOptions.map(stop => <option key={stop.id} value={stop.id}>{stop.name}</option>)}
        </select></label>
        <label><span className="sr-only">Filter unmet demand by bus</span><select value={busId} onChange={event => setBusId(event.target.value)}>
          <option value="all">Bus: all</option>
          {busOptions.map(bus => <option key={bus.id} value={bus.id}>{bus.name}</option>)}
        </select></label>
        <label><span className="sr-only">Filter unmet demand by trip direction</span><select value={direction} onChange={event => setDirection(event.target.value)}><option value="all">Trip: all</option><option value="morning">Morning trips</option><option value="evening">Evening trips</option></select></label>
        <label><span className="sr-only">Filter by alternate-bus status</span><select value={status} onChange={event => setStatus(event.target.value)}>
          <option value="all">Status: all</option>
          <option value="stranded">Stranded only</option>
          <option value="alternative">Had an alternative</option>
        </select></label>
        <label><span className="sr-only">Sort unmet demand</span><select value={sort} onChange={event => setSort(event.target.value)}>
          <option value="stranded">Urgent first</option>
          <option value="volume">Highest volume</option>
          <option value="latest">Most recent</option>
        </select></label>
      </div>
      <p className="result-count" aria-live="polite"><strong>{filteredEvents.length}</strong> rejected report{filteredEvents.length === 1 ? '' : 's'} across <strong>{groups.length}</strong> stop–bus group{groups.length === 1 ? '' : 's'}</p>
      <div className="demand-list">
        {groups.map(group => (
          <details key={group.key} className={`demand-group ${group.strandedCount ? 'has-stranded' : 'has-alternative'}`}>
            <summary>
              <span className="demand-route">
                <span className="demand-signal" aria-hidden="true">{group.strandedCount ? '!' : '↗'}</span>
                <span><strong>{group.stopName} <span aria-hidden="true">→</span> {group.busName}</strong><small>{group.tripDirection} trip · {group.tripDate} · latest {formatCampusTime(group.latestAt, data.campusTimeZone)}</small></span>
              </span>
              <span className="demand-metrics">
                <span><strong>{group.events.length}</strong><small>unable to board</small></span>
                <span><strong>{group.strandedCount}</strong><small>stranded</small></span>
                <span className={`status-label ${group.strandedCount ? 'stranded' : 'info'}`}>{group.strandedCount ? 'No alternate' : 'Alternative available'}</span>
                <span className="disclosure-plus" aria-hidden="true">+</span>
              </span>
            </summary>
            <div className="table-wrap demand-detail"><table>
              <thead><tr><th>Rider</th><th>Trip</th><th>Time</th><th>Report</th><th>Outcome context</th></tr></thead>
              <tbody>
                {group.events.map(event => (
                  <tr key={event.id}>
                    <td><strong>{event.riderName}</strong><small>{event.riderEmail}</small></td>
                    <td><span className={`trip-direction ${event.tripDirection}`}>{event.tripDirection || 'morning'}</span><small>{event.tripDate}</small></td>
                    <td className="subtle audit-time">{formatCampusDateTime(event.timestamp, data.campusTimeZone)}</td>
                    <td>{event.channel === 'ble_confirmed' ? 'BLE confirmed' : 'Soft Hold'}</td>
                    <td>{event.hadAlternateBus
                      ? <span className="status-label info">Other option · {event.alternateBusNames.join(', ')}</span>
                      : <span className="status-label stranded"><span aria-hidden="true">!</span>Stranded</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </details>
        ))}
        {groups.length === 0 && <div className="empty-inline demand-empty"><span aria-hidden="true">✓</span><p>No insufficient-seat events match these filters.</p></div>}
      </div>
    </section>
  )
}
function AuditTab({ data, auditFeed }) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [direction, setDirection] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const merged = Object.values(
    [...(auditFeed || []), ...data.audit].reduce((acc, item) => {
      acc[item.id] = item
      return acc
    }, {})
  ).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
  const visible = merged.filter(item => {
    const matchesKind = kind === 'all' || item.kind === kind
    const matchesDirection = direction === 'all' || item.tripDirection === direction
    const matchesDate = (!dateFrom || item.tripDate >= dateFrom) && (!dateTo || item.tripDate <= dateTo)
    const haystack = `${item.actor} ${item.detail} ${item.kind}`.toLowerCase()
    return matchesKind && matchesDirection && matchesDate && (!query.trim() || haystack.includes(query.trim().toLowerCase()))
  })
  const kinds = [...new Set(merged.map(item => item.kind))]

  return (
    <section className="card wide admin-section list-section">
      <SectionHeading eyebrow="Immutable activity" title="Audit trail" description="Every report attempt—including rejected duplicates—plus unmet demand, archived network records, arrivals, availability corrections, grants, and revocations." />
      <div className="controls filter-bar">
        <label className="search-field"><span className="sr-only">Search audit trail</span><span className="search-icon" aria-hidden="true">⌕</span><input type="search" placeholder="Search actor or detail…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <label><span className="sr-only">Audit event type</span><select value={kind} onChange={event => setKind(event.target.value)}><option value="all">All event types</option>{kinds.map(item => <option key={item} value={item}>{item.replace(/_/g, ' ')}</option>)}</select></label>
        <label><span className="sr-only">Audit trip direction</span><select value={direction} onChange={event => setDirection(event.target.value)}><option value="all">Trip: all</option><option value="morning">Morning trips</option><option value="evening">Evening trips</option></select></label>
        <label className="dated-filter"><span>From</span><input type="date" value={dateFrom} max={dateTo || undefined} onChange={event => setDateFrom(event.target.value)} /></label>
        <label className="dated-filter"><span>To</span><input type="date" value={dateTo} min={dateFrom || undefined} onChange={event => setDateTo(event.target.value)} /></label>
        <span className="result-count"><strong>{visible.length}</strong> events</span>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Time</th><th>Trip</th><th>Type</th><th>Actor</th><th>Detail</th></tr></thead>
        <tbody>
          {visible.map(item => (
            <tr key={item.id}>
              <td className="subtle audit-time">{formatCampusDateTime(item.timestamp, data.campusTimeZone)}</td>
              <td>{item.tripDirection ? <><span className={`trip-direction ${item.tripDirection}`}>{item.tripDirection}</span><small>{item.tripDate}</small></> : <span className="subtle">—</span>}</td>
              <td><span className={`status-label audit-kind ${item.kind}`}>{item.kind.replace(/_/g, ' ')}</span></td>
              <td>{item.actor}</td>
              <td>{item.detail}</td>
            </tr>
          ))}
          {visible.length === 0 && <tr><td colSpan="5" className="subtle">No audit events match this search.</td></tr>}
        </tbody>
      </table></div>
      <p className="privacy-note admin-note"><span aria-hidden="true">◇</span> No reputation scores, trust ratings, or mismatch flags are generated.</p>
    </section>
  )
}

const assistantExamples = [
  'Which stops have no Incharge assigned?',
  'Show buses currently above 90% occupancy',
  'How many Soft Hold releases happened today?',
  'List Incharge assignments changed this week.',
  'Which stop had the most unmet demand this week?',
  'How many riders were unable to board on evening trips this week?'
]

function AssistantTab() {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const ask = async event => {
    event?.preventDefault()
    if (!question.trim() || busy) return
    setBusy(true)
    setError('')
    setAnswer('')
    try {
      const result = await api('/admin/assistant/query', {
        method: 'POST', body: { question: question.trim() }
      })
      setAnswer(result.answer)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card wide admin-section assistant-panel" aria-labelledby="assistant-title">
      <SectionHeading
        eyebrow="Read-only insight"
        title="Ask Campus Seatline"
        description="Ask about current stops, buses, seat counts, Incharge assignments, unmet demand, or audit activity. Demand questions run through a local read-only query layer; no write tools can change transport data."
        action={<span className="status-label info"><span aria-hidden="true">◇</span> Admin only</span>}
      />
      <form className="assistant-form" onSubmit={ask}>
        <label htmlFor="admin-assistant-question">Question</label>
        <div className="assistant-query-row">
          <input
            id="admin-assistant-question"
            value={question}
            maxLength="500"
            onChange={event => setQuestion(event.target.value)}
            placeholder="e.g. Which stops have no Incharge assigned?"
          />
          <button className="btn primary" disabled={!question.trim() || busy} type="submit">
            {busy ? <><span className="spinner" /> Checking</> : 'Ask assistant'}
          </button>
        </div>
        <div className="assistant-examples" aria-label="Example questions">
          {assistantExamples.map(example => (
            <button key={example} type="button" onClick={() => setQuestion(example)}>{example}</button>
          ))}
        </div>
      </form>
      <div className={`assistant-response ${error ? 'error' : answer ? 'ready' : ''}`} role="status" aria-live="polite">
        {error ? (
          <><strong>Assistant unavailable</strong><p>{error}</p></>
        ) : answer ? (
          <><strong>Answer</strong><pre>{answer}</pre></>
        ) : (
          <><strong>Waiting for a question</strong><p>Answers are generated only from the current read-only admin snapshot.</p></>
        )}
      </div>
    </section>
  )
}

const adminTabs = [
  ['overview', 'Overview'], ['schedule', 'Schedule'], ['stops', 'Stops'], ['buses', 'Buses'],
  ['incharge', 'Incharge'], ['users', 'Users'], ['unmet', 'Unmet demand'], ['audit', 'Audit log'], ['assistant', 'AI assistant']
]

export default function AdminPage({ toast, occupancy, auditFeed, refreshTick, connectionStatus }) {
  const [tab, setTab] = useState('overview')
  const [data, setData] = useState(null)
  const [manifestTarget, setManifestTarget] = useState(null)

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
          <h1>Network control desk</h1>
          <p className="supporting">Manage stop-led bus service, rider authority, and live seat counts. Times use {data.campusTimeZone}.</p>
        </div>
      </header>

      <section className="ops-summary" aria-label="Network summary">
        <div className="manifest-stat fleet"><span className="summary-icon bus" aria-hidden="true">▣</span><span><strong>{data.buses.length}</strong><small>Buses in service · {totalCapacity} seats</small></span></div>
        <div className="manifest-stat stops"><span className="summary-icon stop" aria-hidden="true">●</span><span><strong>{data.stops.length}</strong><small>Stops in network</small></span></div>
        <div className="manifest-stat authority"><span className="summary-icon authority" aria-hidden="true">◇</span><span><strong>{activeAssignments}</strong><small>Active Incharge grants</small></span></div>
        <div className={`manifest-stat coverage ${coveredStops < data.stops.length ? 'attention' : 'covered'}`}><span className="summary-icon coverage" aria-hidden="true">{coveredStops < data.stops.length ? '!' : '✓'}</span><span><strong>{data.stops.length - coveredStops}</strong><small>{coveredStops < data.stops.length ? 'Stops need coverage' : 'Every stop is covered'}</small></span></div>
      </section>

      <nav className="tabs admin-tabs" role="tablist" aria-label="Admin sections">
        {adminTabs.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'tab active' : 'tab'} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="admin-content grid">
        {tab === 'overview' && <OverviewTab data={data} occupancy={occupancy} onShowManifest={(bus, state) => setManifestTarget({ busName: bus.name, state, endpoint: `/admin/buses/${bus.id}/riders?state=${state}` })} />}
        {tab === 'schedule' && <ScheduleTab data={data} reload={load} toast={toast} />}
        {tab === 'stops' && <StopsTab data={data} reload={load} toast={toast} />}
        {tab === 'buses' && <BusesTab data={data} reload={load} toast={toast} />}
        {tab === 'incharge' && <AssignmentsTab data={data} reload={load} toast={toast} />}
        {tab === 'users' && <UsersTab data={data} reload={load} toast={toast} />}
        {tab === 'unmet' && <UnmetDemandTab data={data} />}
        {tab === 'audit' && <AuditTab data={data} auditFeed={auditFeed} />}
        {tab === 'assistant' && <AssistantTab />}
      </div>
      {manifestTarget && <RiderManifestDialog target={manifestTarget} refreshKey={refreshTick} onDismiss={() => setManifestTarget(null)} />}
    </div>
  )
}
