import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import {
  DEFAULT_BEACON_MIN_RSSI, disableBackgroundBeaconMonitoring, enableBackgroundBeaconMonitoring,
  getBackgroundBeaconStatus, startServiceUuidScan, supportsNativeBeaconScan
} from '../bleScanner'
import RiderManifestDialog from './RiderManifestDialog'

function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function useCountdown(expiresAt) {
  const [left, setLeft] = useState(() => new Date(expiresAt).getTime() - Date.now())
  useEffect(() => {
    const t = setInterval(() => setLeft(new Date(expiresAt).getTime() - Date.now()), 500)
    return () => clearInterval(t)
  }, [expiresAt])
  return left
}

function PromptCard({ prompt, busy, onAnswer }) {
  const left = useCountdown(prompt.expiresAt)
  const expired = left <= 0
  return (
    <section className="prompt-card" role="alert" aria-labelledby={`prompt-${prompt.id}`}>
      <div className="prompt-signal" aria-hidden="true"><span /><span /><span /></div>
      <div className="prompt-copy">
        <div className="prompt-meta">
          <span className="status-label action">Action needed</span>
          <span className="countdown" aria-label={`${fmt(left)} remaining`}>{fmt(left)}</span>
        </div>
        <h2 id={`prompt-${prompt.id}`}>Are you on {prompt.busName}?</h2>
        <p>Confirm only if you have boarded at <strong>{prompt.stopName}</strong>.</p>
      </div>
      <div className="prompt-actions">
        <button className="btn primary large" disabled={expired || busy} onClick={() => onAnswer(prompt.id, 'yes')}>
          {busy ? <><span className="spinner" /> Saving</> : 'Yes, I boarded'}
        </button>
        <button className="btn secondary large" disabled={expired || busy} onClick={() => onAnswer(prompt.id, 'no')}>No, not this bus</button>
      </div>
      {expired && <p className="prompt-expired">Confirmation window closed. Counts were not changed.</p>}
    </section>
  )
}

function availabilityState(available, capacity) {
  if (available <= 0) return { key: 'full', label: 'Full', symbol: '×', note: 'No seats open' }
  if (available / capacity <= 0.25) return { key: 'tight', label: 'Nearly full', symbol: '!', note: 'Board soon' }
  return { key: 'open', label: 'Seats open', symbol: '✓', note: 'Space available' }
}

function activeBeaconTargets(buses = []) {
  return buses
    .filter(bus => bus.bleEligible && bus.tripStatus === 'active')
    .map(bus => ({ busId: bus.busId }))
}

function beaconTargetSignature(targets = []) {
  return targets
    .map(target => target.busId)
    .sort()
    .join('|')
}

function BusCard({ bus, occupancy, activeBusId, activeIsBoarded, drafts, setDrafts, busyKey, onSoft, onRelease, onAvailable, onShowManifest }) {
  const tripActive = occupancy.tripStatus === 'active'
  const lockedByOther = Boolean(activeIsBoarded && activeBusId !== bus.busId)
  const movingHold = Boolean(activeBusId && !activeIsBoarded && activeBusId !== bus.busId)
  const state = availabilityState(occupancy.availableSeats, occupancy.capacity)
  const maxAvailable = Math.max(0, occupancy.capacity - occupancy.softHolds)
  const draftValue = drafts[bus.busId] ?? occupancy.availableSeats
  const draftNumber = Number(draftValue)
  const previewOccupied = Number.isInteger(draftNumber) && draftNumber >= 0 && draftNumber <= maxAvailable
    ? occupancy.capacity - draftNumber - occupancy.softHolds
    : null

  return (
    <article className={`bus-card state-${state.key}`} aria-labelledby={`bus-${bus.busId}`}>
      <header className="bus-card-head">
        <div>
          <h2 id={`bus-${bus.busId}`}>{bus.busName}</h2>
          <p className="trip-service-line"><strong>{occupancy.tripDirection || 'No'}</strong> trip · {occupancy.tripStatus === 'active' ? 'in service' : occupancy.tripStatus === 'scheduled' ? 'scheduled' : 'not scheduled'}</p>
        </div>
        <div className="bus-badges">
          {bus.inchargeAuthority && <span className="status-label authority"><span aria-hidden="true">◇</span> Incharge access</span>}
          <span className="capacity-label">{occupancy.capacity} seat capacity</span>
        </div>
      </header>

      <div className="availability-board">
        <div className="availability-number">
          <strong>{occupancy.availableSeats}</strong>
          <span>Seats available</span>
        </div>
        <div className={`availability-status ${state.key}`}>
          <span className="status-symbol" aria-hidden="true">{state.symbol}</span>
          <span><strong>{state.label}</strong><small>{state.note}</small></span>
        </div>
        <dl className="seat-breakdown">
          <div><dt>Occupied</dt><dd>{bus.inchargeAuthority && tripActive ? <button type="button" className="count-manifest-link inverse" aria-label={`View ${bus.busName} occupied riders`} onClick={() => onShowManifest(bus, 'seats_occupied')}>{occupancy.seatsOccupied}</button> : occupancy.seatsOccupied}</dd></div>
          <div><dt>Soft Holds</dt><dd>{bus.inchargeAuthority && tripActive ? <button type="button" className="count-manifest-link inverse" aria-label={`View ${bus.busName} Soft Hold riders`} onClick={() => onShowManifest(bus, 'soft_hold')}>{occupancy.softHolds}</button> : occupancy.softHolds}</dd></div>
        </dl>
      </div>

      <div className="route-section">
        <h3 className="route-heading">{occupancy.tripDirection === 'evening' ? 'Evening stop sequence' : 'Morning stop sequence'}</h3>
        <ol className="route-rail" aria-label={`${bus.busName} stop sequence`}>
          {bus.stopNames.map((name, index) => {
            const passed = bus.passedStopIds.includes(bus.stopIds[index])
            const boarding = bus.boardingStopIds?.includes(bus.stopIds[index])
            return <li key={bus.stopIds[index]} className={`${passed ? 'passed' : ''} ${boarding ? 'boarding-stop' : 'alight-only'}`}><span aria-hidden="true" />{name}<small>{passed ? 'Reported' : boarding ? 'Boarding and reporting' : 'Alight only'}</small></li>
          })}
        </ol>
      </div>

      <div className="rider-decision">
        {!tripActive ? (
          <div className="decision-state neutral"><span aria-hidden="true">◷</span><span><strong>This trip has not started</strong><small>Reporting opens automatically at the configured start time</small></span></div>
        ) : bus.boarded ? (
          <div className="decision-state success"><span aria-hidden="true">✓</span><span><strong>You’re counted on this bus</strong><small>{occupancy.tripDirection === 'evening' ? 'Keep BLE monitoring on for the alight decrement at your stop' : 'One confirmed report for this trip'}</small></span></div>
        ) : bus.holding ? (
          <div className="held-actions">
            <div className="decision-state held"><span aria-hidden="true">◷</span><span><strong>Your Soft Hold is active</strong><small>Confirm after the BLE boarding prompt appears</small></span></div>
            <button className="btn secondary" disabled={Boolean(busyKey)} onClick={() => onRelease(bus.busId)}>
              {busyKey === `release-${bus.busId}` ? <><span className="spinner dark" /> Releasing</> : 'Release Soft Hold'}
            </button>
          </div>
        ) : lockedByOther ? (
          <div className="decision-state neutral"><span aria-hidden="true">—</span><span><strong>Another bus is selected</strong><small>Only one active bus report is allowed per trip</small></span></div>
        ) : (
          <>
            <div className="decision-copy"><strong>{movingHold ? 'Prefer this bus instead?' : `Planning to board this ${occupancy.tripDirection || ''} trip?`}</strong><span>{movingHold ? 'Your current Soft Hold will move here atomically.' : 'A “Yes” reserves one Soft Hold.'}</span></div>
            <div className="segmented-actions" aria-label={`Planning to board ${bus.busName}`}>
              <button className="btn primary" disabled={Boolean(busyKey)} onClick={() => onSoft(bus.busId, 'yes')}>
                {busyKey === `soft-${bus.busId}` ? <><span className="spinner" /> Saving</> : movingHold ? 'Move hold here' : 'Yes, hold a seat'}
              </button>
              <button className="btn secondary" disabled={Boolean(busyKey)} onClick={() => onSoft(bus.busId, 'no')}>No</button>
            </div>
          </>
        )}
      </div>

      {bus.inchargeAuthority && (
        <section className="incharge-panel" aria-labelledby={`incharge-${bus.busId}`}>
          <div className="incharge-heading">
            <div><h3 id={`incharge-${bus.busId}`}>Correct Seats Available</h3></div>
            <span className="audit-note"><span aria-hidden="true">●</span> Audit logged</span>
          </div>
          <p>Use this only when the live count needs a physical correction. Seats Occupied is recalculated automatically.</p>
          <div className="ble-diagnostic" role="status">
            <span aria-hidden="true">◉</span>
            <span><strong>BLE signal diagnostic</strong><small>{bus.bleDiagnostic?.lastDetectedAt
              ? `Last detected ${relativeAge(bus.bleDiagnostic.lastDetectedAt)} · ${bus.bleDiagnostic.lastDetectionStatus}`
              : 'No bus signal detected for this trip yet'}</small></span>
          </div>
          <div className="availability-editor">
            <label>
              Seats Available
              <input
                inputMode="numeric"
                type="number"
                min="0"
                max={maxAvailable}
                value={draftValue}
                onChange={event => setDrafts(current => ({ ...current, [bus.busId]: event.target.value }))}
              />
            </label>
            <div className="derived-preview" aria-live="polite">
              <span>Derived Occupied</span>
              <strong>{previewOccupied ?? '—'}</strong>
            </div>
            <button
              className="btn authority-action"
              onClick={() => onAvailable(bus.busId)}
              disabled={busyKey === `available-${bus.busId}` || drafts[bus.busId] === undefined ||
                draftNumber === occupancy.availableSeats || previewOccupied === null}
            >
              {busyKey === `available-${bus.busId}` ? <><span className="spinner" /> Updating</> : 'Update availability'}
            </button>
          </div>
          <small className="editor-limit">Allowed range: 0–{maxAvailable} while {occupancy.softHolds} Soft Hold{occupancy.softHolds === 1 ? ' is' : 's are'} active.</small>
        </section>
      )}
    </article>
  )
}

function relativeAge(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

export default function RiderPage({ user, toast, occupancy, prompts, notifications, refreshTick, connectionStatus }) {
  const [overview, setOverview] = useState(null)
  const [beaconMinRssi, setBeaconMinRssi] = useState(String(DEFAULT_BEACON_MIN_RSSI))
  const [bleScan, setBleScan] = useState({ active: false, message: 'Ready to scan' })
  const [backgroundBle, setBackgroundBle] = useState({
    active: false, targetCount: 0, targetSignature: '', message: 'Background alerts are off'
  })
  const [availableDrafts, setAvailableDrafts] = useState({})
  const [stopDraft, setStopDraft] = useState('')
  const [busyKey, setBusyKey] = useState('')
  const [manifestTarget, setManifestTarget] = useState(null)
  const scanControllerRef = useRef(null)
  const detectionHandledRef = useRef(false)

  const load = () => api('/rider/overview').then(setOverview).catch(error => toast(error.message, 'error'))
  useEffect(() => { load() }, [])
  useEffect(() => { if (refreshTick > 0) load() }, [refreshTick])
  useEffect(() => () => {
    void scanControllerRef.current?.stop()
  }, [])
  useEffect(() => {
    if (!supportsNativeBeaconScan()) return
    getBackgroundBeaconStatus()
      .then(status => {
        setBackgroundBle({
          active: Boolean(status.backgroundMonitoring),
          targetCount: Number(status.backgroundTargetCount || 0),
          targetSignature: status.backgroundTargetSignature || '',
          message: status.backgroundMonitoring
            ? `Background proximity alerts are active for ${status.backgroundTargetCount || 0} bus beacon${status.backgroundTargetCount === 1 ? '' : 's'}`
            : 'Background alerts are off'
        })
        if (status.backgroundMonitoring) {
          setBeaconMinRssi(String(status.backgroundMinRssi ?? DEFAULT_BEACON_MIN_RSSI))
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!supportsNativeBeaconScan() || !overview || !backgroundBle.active) return
    const boardedEveningBusIds = new Set(overview.buses
      .filter(bus => overview.boardedBusIds?.includes(bus.busId) && bus.tripDirection === 'evening')
      .map(bus => bus.busId))
    const buses = overview.boardedBusIds?.length
      ? overview.buses.filter(bus => boardedEveningBusIds.has(bus.busId))
      : overview.buses
    const targets = activeBeaconTargets(buses)
    const targetSignature = beaconTargetSignature(targets)
    if (targetSignature === backgroundBle.targetSignature) return

    if (!targets.length) {
      void disableBackgroundBeaconMonitoring().then(() => {
        setBackgroundBle({ active: false, targetCount: 0, targetSignature: '', message: 'No eligible bus beacons remain' })
      }).catch(() => {})
      return
    }

    void enableBackgroundBeaconMonitoring({
      beacons: targets,
      minRssi: Number(beaconMinRssi)
    }).then(result => {
      setBackgroundBle({
        active: true,
        targetCount: Number(result.targetCount || targets.length),
        targetSignature: result.targetSignature || targetSignature,
        message: `Background alerts updated for ${targets.length} bus beacon${targets.length === 1 ? '' : 's'} at your stop`
      })
    }).catch(error => {
      setBackgroundBle(current => ({ ...current, message: `Could not update bus beacons: ${error.message}` }))
    })
  }, [overview, backgroundBle.active, backgroundBle.targetSignature, beaconMinRssi])

  const run = async (key, action) => {
    if (busyKey) return
    setBusyKey(key)
    try {
      await action()
      await load()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      setBusyKey('')
    }
  }

  const answerSoft = (busId, response) => run(`soft-${busId}`, () =>
    api('/rider/soft-hold', { method: 'POST', body: { busId, response } }))

  const releaseHold = busId => run(`release-${busId}`, async () => {
    await api('/rider/soft-hold/release', { method: 'POST', body: { busId } })
    toast('Soft Hold released', 'feedback')
  })

  const setDailyStop = () => run('daily-stop', async () => {
    await api('/rider/daily-stop', { method: 'POST', body: { stopId: stopDraft } })
    setStopDraft('')
    toast('Today’s boarding stop updated; your registered stop is unchanged', 'feedback')
  })

  const resetDailyStop = () => run('daily-stop-reset', async () => {
    await api('/rider/daily-stop', { method: 'DELETE' })
    setStopDraft('')
    toast('Boarding stop reset to your registered stop', 'feedback')
  })

  const stopBeaconScan = async (message = 'Beacon scan stopped') => {
    const controller = scanControllerRef.current
    scanControllerRef.current = null
    await controller?.stop()
    setBleScan({ active: false, message })
  }

  const startBeaconScan = async () => {
    if (busyKey || bleScan.active) return
    if (!supportsNativeBeaconScan()) {
      toast('Install the Android APK to test an external Bluetooth beacon', 'error')
      return
    }

    const targets = activeBeaconTargets(overview.buses)
    if (!targets.length) {
      toast('No active bus beacons are assigned to your stop', 'error')
      return
    }

    detectionHandledRef.current = false
    setBleScan({ active: true, message: `Scanning for all ${targets.length} bus beacon${targets.length === 1 ? '' : 's'} at your stop...` })

    let controller
    try {
      controller = await startServiceUuidScan({
        beacons: targets,
        minRssi: Number(beaconMinRssi),
        timeoutMs: 30000,
        onDetected: detection => {
          if (detectionHandledRef.current) return
          detectionHandledRef.current = true
          const matchedBus = overview.buses.find(bus => bus.busId === detection.busId)
          setBleScan({
            active: true,
            message: `${matchedBus?.busName || 'Bus'} matched at RSSI ${detection.rssi}. Verifying with the server...`
          })
          void (async () => {
            try {
              const result = await api('/rider/ble/detected', {
                method: 'POST',
                body: {
                  busId: detection.busId,
                  beacon: {
                    format: detection.format,
                    uuid: detection.uuid,
                    rssi: detection.rssi,
                    txPower: detection.txPower
                  }
                }
              })
              toast(result.alighted
                ? `Alighting recorded for ${matchedBus?.busName || 'the bus'}`
                : `${matchedBus?.busName || 'Bus'} beacon verified - boarding confirmation is ready`, result.alighted ? 'feedback' : 'prompt')
              setBleScan({ active: false, message: result.alighted
                ? `${matchedBus?.busName || 'Bus'} alight decrement recorded`
                : `${matchedBus?.busName || 'Bus'} matched the server’s bus mapping` })
              await load()
            } catch (error) {
              setBleScan({ active: false, message: error.message })
              toast(error.message, 'error')
            } finally {
              scanControllerRef.current = null
              await controller?.dispose()
            }
          })()
        },
        onState: event => {
          if (event.state === 'timed_out') {
            setBleScan({ active: false, message: 'No matching bus beacon found in 30 seconds' })
            toast('No matching service UUID found. Check the transmitter UUID and advertising status.', 'info')
            scanControllerRef.current?.dispose()
            scanControllerRef.current = null
          } else if (event.state === 'paused') {
            setBleScan({ active: false, message: 'Scan stopped because the app left the foreground' })
            scanControllerRef.current?.dispose()
            scanControllerRef.current = null
          } else if (event.state === 'failed') {
            const message = event.message || 'Android Bluetooth scan failed'
            setBleScan({ active: false, message })
            toast(message, 'error')
            scanControllerRef.current?.dispose()
            scanControllerRef.current = null
          }
        }
      })
      scanControllerRef.current = controller
    } catch (error) {
      setBleScan({ active: false, message: error.message })
      toast(error.message, 'error')
    }
  }
  const answerPrompt = (id, response) => run(`prompt-${id}`, async () => {
    await api(`/rider/prompts/${id}/respond`, { method: 'POST', body: { response } })
    const answeredPrompt = (prompts ?? overview?.prompts ?? []).find(prompt => prompt.id === id)
    if (response === 'yes' && backgroundBle.active && answeredPrompt?.tripDirection !== 'evening') {
      await disableBackgroundBeaconMonitoring()
      setBackgroundBle({ active: false, targetCount: 0, targetSignature: '', message: 'Boarding confirmed; background alerts stopped' })
    } else if (response === 'yes' && backgroundBle.active && answeredPrompt?.tripDirection === 'evening') {
      setBackgroundBle(current => ({ ...current, message: 'Boarding confirmed; monitoring continues for your alighting stop' }))
    }
  })

  const enableBackgroundBle = () => run('ble-background', async () => {
    if (!supportsNativeBeaconScan()) {
      throw new Error('Background beacon monitoring is available only in the Android app')
    }
    const targets = activeBeaconTargets(overview.buses)
    if (!targets.length) {
      throw new Error('No active bus beacons are assigned to your stop')
    }
    const result = await enableBackgroundBeaconMonitoring({
      beacons: targets,
      minRssi: Number(beaconMinRssi)
    })
    setBackgroundBle({
      active: true,
      targetCount: Number(result.targetCount || targets.length),
      targetSignature: result.targetSignature || beaconTargetSignature(targets),
      message: `Background proximity alerts are active for all ${targets.length} bus beacon${targets.length === 1 ? '' : 's'} at your stop, including when the app is closed`
    })
    toast(`Background alerts enabled for ${targets.length} bus${targets.length === 1 ? '' : 'es'} at your stop`, 'feedback')
  })
  const disableBackgroundBle = () => run('ble-background', async () => {
    await disableBackgroundBeaconMonitoring()
    setBackgroundBle({
      active: false,
      targetCount: 0,
      targetSignature: '',
      message: 'Background alerts are off'
    })
    toast('Background beacon alerts disabled', 'feedback')
  })

  const setAvailable = busId => run(`available-${busId}`, async () => {
    await api(`/rider/incharge/buses/${busId}/available`, {
      method: 'POST', body: { seatsAvailable: Number(availableDrafts[busId]) }
    })
    setAvailableDrafts(current => {
      const next = { ...current }
      delete next[busId]
      return next
    })
    toast('Seats Available updated; Seats Occupied was recalculated', 'feedback')
  })

  const combinedNotifications = useMemo(() => {
    if (!overview) return []
    const byId = new Map()
    for (const item of [...notifications, ...overview.notifications]) byId.set(item.id, item)
    return [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }, [notifications, overview])

  if (!overview) return <div className="loading-state"><span className="spinner dark" /> Loading your buses</div>

  if (!overview.serviceDay) {
    return (
      <div className="rider-page">
        <header className="page-intro rider-intro">
          <div>
            <p className="dayline">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</p>
            <h1>No trips scheduled today</h1>
            <p className="supporting">The Operating Calendar marks today as a non-service day.</p>
          </div>
        </header>
        <section className="no-service-board" aria-labelledby="no-service-title">
          <span className="no-service-symbol" aria-hidden="true">○</span>
          <div><h2 id="no-service-title">Service resumes on the next operating day</h2><p>Boarding prompts, Soft Holds, and BLE reporting are off because no Morning or Evening Trips were generated.</p></div>
        </section>
        <p className="privacy-footer"><span aria-hidden="true">◎</span> Seatline uses rider confirmations and BLE proximity only. No GPS or continuous location data is collected.</p>
      </div>
    )
  }

  const livePrompts = prompts ?? overview.prompts
  const activeBusId = overview.boardedBusIds?.[0] || overview.softHoldBusIds?.[0] || null
  const activeIsBoarded = activeBusId && overview.boardedBusIds?.includes(activeBusId)
  const activeBus = overview.buses.find(bus => bus.busId === activeBusId)
  const eligibleBleBuses = activeIsBoarded
    ? (activeBus?.tripDirection === 'evening' ? [activeBus] : [])
    : overview.buses
  const beaconTargets = activeBeaconTargets(eligibleBleBuses)
  const parsedBeaconMinRssi = Number(beaconMinRssi)
  const beaconConfigValid = beaconTargets.length > 0 &&
    Number.isInteger(parsedBeaconMinRssi) && parsedBeaconMinRssi >= -100 && parsedBeaconMinRssi <= -30
  const timeline = overview.stops.flatMap(stop => stop.timeline.map(row => ({ ...row, stopName: stop.name })))
  const beaconConfigLocked = bleScan.active || backgroundBle.active

  return (
    <div className="rider-page">
      <header className="page-intro rider-intro">
        <div>
          <p className="dayline">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</p>
          <h1>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, {user.name.split(' ')[0]}</h1>
          <p className="supporting">Your buses for {overview.stops.map(stop => stop.name).join(' · ')}</p>
        </div>
        <div className="intro-meta">
          {timeline.slice(0, 2).map((row, index) => <span key={`${row.stopName}-${row.time}-${index}`}><strong>{row.time}</strong> {row.label || row.stopName}</span>)}
        </div>
      </header>

      {livePrompts.length > 0 && (
        <div className="prompt-stack">
          {livePrompts.map(prompt => <PromptCard key={prompt.id} prompt={prompt} busy={busyKey === `prompt-${prompt.id}`} onAnswer={answerPrompt} />)}
        </div>
      )}

      <section className="bus-list" aria-label="Buses serving your stops">
        {overview.buses.length === 0 && (
          <div className="empty-state"><span className="empty-icon" aria-hidden="true">○</span><h2>No buses linked yet</h2><p>Your stop is registered, but an admin has not linked a bus to it.</p></div>
        )}
        {overview.buses.map(bus => (
          <BusCard
            key={bus.busId}
            bus={{ ...bus, boarded: overview.boardedBusIds?.includes(bus.busId), holding: overview.softHoldBusIds?.includes(bus.busId) }}
            occupancy={occupancy[bus.busId] || bus}
            activeBusId={activeBusId}
            activeIsBoarded={activeIsBoarded}
            drafts={availableDrafts}
            setDrafts={setAvailableDrafts}
            busyKey={busyKey}
            onSoft={answerSoft}
            onRelease={releaseHold}
            onAvailable={setAvailable}
            onShowManifest={(bus, state) => setManifestTarget({ busName: bus.busName, state, endpoint: `/rider/incharge/buses/${bus.busId}/riders?state=${state}` })}
          />
        ))}
      </section>

      <section className="utility-grid">
        <div className="card ble-card">
          <div className="utility-icon signal" aria-hidden="true"><span /><span /><span /></div>
          <div className="utility-copy">
            <h2>Detect bus proximity</h2>
            <p>Seatline watches the buses serving your stop in the foreground or while the app is closed. Beacon identities stay private to transport Admins; no bus selection, GPS, or location permission is required.</p>
          </div>
          {eligibleBleBuses.length === 0 ? (
            <div className={`decision-state ${activeIsBoarded ? 'success' : 'neutral'} compact`}><span aria-hidden="true">{activeIsBoarded ? '✓' : '◷'}</span><span><strong>{activeIsBoarded ? 'Boarding already confirmed' : 'No active trip beacons'}</strong><small>{activeIsBoarded ? 'No further report is needed this trip.' : 'Monitoring becomes available when a scheduled trip starts.'}</small></span></div>
          ) : (
            <>
              <div className="ble-actions">
                <div className="decision-state neutral compact">
                  <span aria-hidden="true">◎</span>
                  <span><strong>{beaconTargets.length} bus beacon{beaconTargets.length === 1 ? '' : 's'} monitored</strong><small>Matched automatically from the buses serving your stop</small></span>
                </div>
                <div className="ble-action-buttons">
                  {bleScan.active ? (
                    <button className="btn secondary" onClick={() => stopBeaconScan()}>
                      Stop scan
                    </button>
                  ) : (
                    <button
                      className="btn primary"
                      disabled={!beaconConfigValid || Boolean(busyKey)}
                      onClick={startBeaconScan}
                    >
                      Scan for nearby buses
                    </button>
                  )}
                  {backgroundBle.active ? (
                    <button
                      className="btn secondary"
                      disabled={bleScan.active || busyKey === 'ble-background'}
                      onClick={disableBackgroundBle}
                    >
                      {busyKey === 'ble-background' ? 'Disabling…' : 'Disable background alerts'}
                    </button>
                  ) : (
                    <button
                      className="btn secondary"
                      disabled={!beaconConfigValid || bleScan.active || Boolean(busyKey)}
                      onClick={enableBackgroundBle}
                    >
                      {busyKey === 'ble-background' ? 'Enabling…' : 'Enable closed-app alerts'}
                    </button>
                  )}
                </div>
              </div>

              <details className="beacon-config">
                <summary>Proximity settings</summary>
                <div className="beacon-fields">
                  <label>Reachable signal (dBm)
                    <input
                      type="number"
                      inputMode="numeric"
                      min="-100"
                      max="-30"
                      value={beaconMinRssi}
                      disabled={beaconConfigLocked}
                      onChange={event => setBeaconMinRssi(event.target.value)}
                    />
                  </label>
                </div>
                <small>
                  Bus identities are matched privately by the app and transport server. One-time scans stop after 30 seconds. Closed-app alerts trigger only at or above the selected signal threshold.
                </small>
              </details>

              <p className={`beacon-scan-status ${bleScan.active ? 'active' : ''}`} role="status" aria-live="polite">
                <span aria-hidden="true">{bleScan.active ? '●' : '○'}</span>
                {bleScan.message}
              </p>
              <p className={`beacon-scan-status ${backgroundBle.active ? 'active' : ''}`} role="status" aria-live="polite">
                <span aria-hidden="true">{backgroundBle.active ? '●' : '○'}</span>
                {backgroundBle.message}
              </p>
            </>
          )}
        </div>

        <details className="card notifications-card" open={livePrompts.length === 0 && combinedNotifications.length > 0}>
          <summary>
            <span><strong>Notifications</strong></span>
            <span className="notification-count">{combinedNotifications.length}</span>
          </summary>
          {combinedNotifications.length === 0 ? (
            <div className="empty-inline"><span aria-hidden="true">○</span><p>No updates yet. Arrival reports from earlier stops will appear here.</p></div>
          ) : (
            <ul className="notification-list">
              {combinedNotifications.map(item => (
                <li key={item.id} className={item.type}>
                  <span className="notification-symbol" aria-hidden="true">{item.type === 'arrival' ? '→' : item.type === 'error' ? '!' : '✓'}</span>
                  <span>{item.message}<time>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></span>
                </li>
              ))}
            </ul>
          )}
        </details>

        <details className="card stop-override-card">
          <summary>
            <span><span className="section-context">Today’s trip</span><strong>Boarding from a different stop today?</strong></span>
            <span className="disclosure-plus" aria-hidden="true">+</span>
          </summary>
          <p>Your registered stop stays unchanged. This selection automatically expires when today’s trip day ends.</p>
          <p className="current-stop-context"><strong>Using today:</strong> {overview.stops.map(stop => stop.name).join(' · ')}</p>
          <label className="field-label">Different stop
            <select value={stopDraft} onChange={event => setStopDraft(event.target.value)}>
              <option value="">Choose a stop…</option>
              {overview.availableStops
                .filter(stop => !overview.stops.some(current => current.id === stop.id))
                .map(stop => <option key={stop.id} value={stop.id}>{stop.name}</option>)}
            </select>
          </label>
          <div className="row">
            <button className="btn primary" disabled={!stopDraft || Boolean(busyKey)} onClick={setDailyStop}>
              {busyKey === 'daily-stop' ? <><span className="spinner" /> Saving</> : 'Use this stop today'}
            </button>
            {overview.dailyStopOverride && (
              <button className="btn secondary" disabled={Boolean(busyKey)} onClick={resetDailyStop}>
                {busyKey === 'daily-stop-reset' ? <><span className="spinner dark" /> Resetting</> : 'Use my registered stop'}
              </button>
            )}
          </div>
        </details>
      </section>

      {overview.myAssignments.length > 0 && (
        <p className="authority-footnote"><span aria-hidden="true">◇</span> Your Incharge authority: {overview.myAssignments.map(item => `${item.scopeType === 'bus' ? 'Bus' : 'Stop'} · ${item.scopeName}`).join(', ')}</p>
      )}
      <p className="privacy-footer"><span aria-hidden="true">◎</span> Seatline uses rider confirmations and BLE proximity only. No GPS or continuous location data is collected.</p>
      {manifestTarget && <RiderManifestDialog target={manifestTarget} refreshKey={refreshTick} onDismiss={() => setManifestTarget(null)} />}
    </div>
  )
}
