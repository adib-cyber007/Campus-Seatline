import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import {
  DEFAULT_TEST_BEACON, disableBackgroundBeaconMonitoring, enableBackgroundBeaconMonitoring,
  getBackgroundBeaconStatus, startIBeaconScan, supportsNativeBeaconScan
} from '../bleScanner'

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

function BusCard({ bus, occupancy, activeBusId, activeIsBoarded, drafts, setDrafts, busyKey, onSoft, onRelease, onAvailable }) {
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
          <span className="eyebrow">Bus serving your stop</span>
          <h2 id={`bus-${bus.busId}`}>{bus.busName}</h2>
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
          <div><dt>Occupied</dt><dd>{occupancy.seatsOccupied}</dd></div>
          <div><dt>Soft Holds</dt><dd>{occupancy.softHolds}</dd></div>
        </dl>
      </div>

      <div className="route-section">
        <span className="section-label">Stop sequence</span>
        <ol className="route-rail" aria-label={`${bus.busName} stop sequence`}>
          {bus.stopNames.map((name, index) => {
            const passed = bus.passedStopIds.includes(bus.stopIds[index])
            return <li key={bus.stopIds[index]} className={passed ? 'passed' : ''}><span aria-hidden="true" />{name}{passed && <small>Reported</small>}</li>
          })}
        </ol>
      </div>

      <div className="rider-decision">
        {bus.boarded ? (
          <div className="decision-state success"><span aria-hidden="true">✓</span><span><strong>You’re counted on this bus</strong><small>One confirmed report for this trip</small></span></div>
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
            <div className="decision-copy"><strong>{movingHold ? 'Prefer this bus instead?' : 'Planning to board today?'}</strong><span>{movingHold ? 'Your current Soft Hold will move here atomically.' : 'A “Yes” reserves one Soft Hold.'}</span></div>
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
            <div><span className="eyebrow">Authority control</span><h3 id={`incharge-${bus.busId}`}>Correct Seats Available</h3></div>
            <span className="audit-note"><span aria-hidden="true">●</span> Audit logged</span>
          </div>
          <p>Use this only when the live count needs a physical correction. Seats Occupied is recalculated automatically.</p>
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

export default function RiderPage({ user, toast, occupancy, prompts, notifications, refreshTick, connectionStatus }) {
  const [overview, setOverview] = useState(null)
  const [bleBus, setBleBus] = useState('')
  const [beaconConfig, setBeaconConfig] = useState({
    format: DEFAULT_TEST_BEACON.format,
    uuid: DEFAULT_TEST_BEACON.uuid,
    major: String(DEFAULT_TEST_BEACON.major),
    minor: String(DEFAULT_TEST_BEACON.minor),
    minRssi: String(DEFAULT_TEST_BEACON.minRssi)
  })
  const [bleScan, setBleScan] = useState({ active: false, message: 'Ready to scan' })
  const [backgroundBle, setBackgroundBle] = useState({ active: false, busId: '', message: 'Background alerts are off' })
  const [availableDrafts, setAvailableDrafts] = useState({})
  const [stopDraft, setStopDraft] = useState('')
  const [busyKey, setBusyKey] = useState('')
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
          busId: status.backgroundBusId || '',
          message: status.backgroundMonitoring ? 'Background proximity alerts are active' : 'Background alerts are off'
        })
        if (status.backgroundMonitoring) {
          setBleBus(status.backgroundBusId || '')
          setBeaconConfig(config => ({
            ...config,
            format: status.backgroundFormat || config.format,
            uuid: status.backgroundUuid || config.uuid,
            major: String(status.backgroundMajor ?? config.major),
            minor: String(status.backgroundMinor ?? config.minor),
            minRssi: String(status.backgroundMinRssi ?? config.minRssi)
          }))
        }
      })
      .catch(() => {})
  }, [])

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

  const triggerBle = () => run('ble', async () => {
    await api('/rider/ble/simulate', { method: 'POST', body: { busId: bleBus } })
    toast('Boarding confirmation is ready', 'prompt')
  })

  const stopBeaconScan = async (message = 'Beacon scan stopped') => {
    const controller = scanControllerRef.current
    scanControllerRef.current = null
    await controller?.stop()
    setBleScan({ active: false, message })
  }

  const startBeaconScan = async () => {
    if (!bleBus || busyKey || bleScan.active) return
    if (!supportsNativeBeaconScan()) {
      toast('Install the Android APK to test an external Bluetooth beacon', 'error')
      return
    }

    const major = Number(beaconConfig.major)
    const minor = Number(beaconConfig.minor)
    const selectedBusId = bleBus
    detectionHandledRef.current = false
    setBleScan({ active: true, message: 'Scanning for the configured iBeacon...' })

    let controller
    try {
      controller = await startIBeaconScan({
        format: beaconConfig.format,
        uuid: beaconConfig.uuid,
        major,
        minRssi: Number(beaconConfig.minRssi),
        minor,
        timeoutMs: 30000,
        onDetected: detection => {
          if (detectionHandledRef.current) return
          detectionHandledRef.current = true
          setBleScan({ active: true, message: `Beacon matched at RSSI ${detection.rssi}. Creating confirmation...` })
          void (async () => {
            try {
              await api('/rider/ble/detected', {
                method: 'POST',
                body: {
                  busId: selectedBusId,
                  beacon: {
                    format: detection.format,
                    uuid: detection.uuid,
                    major: detection.major,
                    minor: detection.minor,
                    rssi: detection.rssi,
                    txPower: detection.txPower
                  }
                }
              })
              toast('External bus beacon detected - boarding confirmation is ready', 'prompt')
              setBleScan({ active: false, message: 'Beacon matched and verified by the server' })
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
            setBleScan({ active: false, message: 'No matching beacon found in 30 seconds' })
            toast('No matching iBeacon found. Check UUID, major, minor and transmitter status.', 'info')
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
    if (response === 'yes' && backgroundBle.active) {
      await disableBackgroundBeaconMonitoring()
      setBackgroundBle({ active: false, busId: '', message: 'Boarding confirmed; background alerts stopped' })
    }
  })

  const enableBackgroundBle = () => run('ble-background', async () => {
    if (!bleBus || !supportsNativeBeaconScan()) {
      throw new Error('Choose a bus in the Android app before enabling background alerts')
    }
    const result = await enableBackgroundBeaconMonitoring({
      busId: bleBus,
      format: beaconConfig.format,
      uuid: beaconConfig.uuid,
      major: Number(beaconConfig.major),
      minor: Number(beaconConfig.minor),
      minRssi: Number(beaconConfig.minRssi)
    })
    setBackgroundBle({
      active: true,
      busId: result.busId || bleBus,
      message: 'Background proximity alerts are active, including when the app is closed'
    })
    toast('Background beacon alerts enabled', 'feedback')
  })

  const disableBackgroundBle = () => run('ble-background', async () => {
    await disableBackgroundBeaconMonitoring()
    setBackgroundBle({
      active: false,
      busId: '',
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

  const livePrompts = prompts ?? overview.prompts
  const activeBusId = overview.boardedBusIds?.[0] || overview.softHoldBusIds?.[0] || null
  const activeIsBoarded = activeBusId && overview.boardedBusIds?.includes(activeBusId)
  const eligibleBleBuses = activeIsBoarded
    ? []
    : overview.buses
  const beaconMajor = Number(beaconConfig.major)
  const beaconMinor = Number(beaconConfig.minor)
  const beaconMinRssi = Number(beaconConfig.minRssi)
  const beaconConfigValid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(beaconConfig.uuid.trim()) &&
    (beaconConfig.format === 'service_uuid' || (
      Number.isInteger(beaconMajor) && beaconMajor >= 0 && beaconMajor <= 65535 &&
      Number.isInteger(beaconMinor) && beaconMinor >= 0 && beaconMinor <= 65535
    )) &&
    Number.isInteger(beaconMinRssi) && beaconMinRssi >= -100 && beaconMinRssi <= -30
  const timeline = overview.stops.flatMap(stop => stop.timeline.map(row => ({ ...row, stopName: stop.name })))
  const beaconConfigLocked = bleScan.active || backgroundBle.active

  return (
    <div className="rider-page">
      <header className="page-intro rider-intro">
        <div>
          <p className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</p>
          <h1>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, {user.name.split(' ')[0]}</h1>
          <p className="supporting">Your buses for {overview.stops.map(stop => stop.name).join(' · ')}</p>
        </div>
        <div className="intro-meta">
          {timeline.slice(0, 2).map((row, index) => <span key={`${row.stopName}-${row.time}-${index}`}><strong>{row.time}</strong> {row.label || row.stopName}</span>)}
          <span className={`sync-pill ${connectionStatus}`}><span />{connectionStatus === 'live' ? 'Counts updating live' : 'Trying to reconnect'}</span>
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
          />
        ))}
      </section>

      <section className="utility-grid">
        <div className="card ble-card">
          <div className="utility-icon signal" aria-hidden="true"><span /><span /><span /></div>
          <div className="utility-copy">
            <span className="eyebrow">External beacon test</span>
            <h2>Detect bus proximity</h2>
            <p>Detect a configured bus beacon in the foreground or while the app is closed. No GPS or location permission is used.</p>
          </div>
          {eligibleBleBuses.length === 0 ? (
            <div className="decision-state success compact"><span aria-hidden="true">✓</span><span><strong>Boarding already confirmed</strong><small>No further report is needed this trip.</small></span></div>
          ) : (
            <>
              <div className="ble-actions">
                <label>Beacon represents
                  <select value={bleBus} disabled={beaconConfigLocked} onChange={event => setBleBus(event.target.value)}>
                    <option value="">Choose a bus…</option>
                    {eligibleBleBuses.map(bus => <option key={bus.busId} value={bus.busId}>{bus.busName}</option>)}
                  </select>
                </label>
                <div className="ble-action-buttons">
                  {bleScan.active ? (
                    <button className="btn secondary" onClick={() => stopBeaconScan()}>
                      Stop scan
                    </button>
                  ) : (
                    <button
                      className="btn primary"
                      disabled={!bleBus || !beaconConfigValid || Boolean(busyKey)}
                      onClick={startBeaconScan}
                    >
                      {beaconConfig.format === 'ibeacon' ? 'Scan for iBeacon' : 'Scan for BLE service'}
                    </button>
                  )}
                  <button
                    className="btn quiet"
                    disabled={!bleBus || bleScan.active || Boolean(busyKey)}
                    onClick={triggerBle}
                    aria-label="Use the original mock BLE trigger"
                  >
                    {busyKey === 'ble' ? <><span className="spinner dark" /> Triggering</> : 'Use mock trigger'}
                  </button>
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
                      disabled={!bleBus || !beaconConfigValid || bleScan.active || Boolean(busyKey)}
                      onClick={enableBackgroundBle}
                    >
                      {busyKey === 'ble-background' ? 'Enabling…' : 'Enable closed-app alerts'}
                    </button>
                  )}
                </div>
              </div>

              <details className="beacon-config" open>
                <summary>Simulator beacon identity</summary>
                <div className="beacon-fields">
                  <label className="beacon-format">Broadcast format
                    <select
                      value={beaconConfig.format}
                      disabled={beaconConfigLocked}
                      onChange={event => setBeaconConfig(config => ({ ...config, format: event.target.value }))}
                    >
                      <option value="ibeacon">iBeacon</option>
                      <option value="service_uuid">Custom BLE service UUID</option>
                    </select>
                  </label>
                  <label className="beacon-uuid">UUID
                    <input
                      value={beaconConfig.uuid}
                      disabled={beaconConfigLocked}
                      autoCapitalize="characters"
                      spellCheck="false"
                      onChange={event => setBeaconConfig(config => ({ ...config, uuid: event.target.value }))}
                    />
                  </label>
                  {beaconConfig.format === 'ibeacon' && (
                    <>
                      <label>Major
                        <input
                          type="number"
                          inputMode="numeric"
                          min="0"
                          max="65535"
                          value={beaconConfig.major}
                          disabled={beaconConfigLocked}
                          onChange={event => setBeaconConfig(config => ({ ...config, major: event.target.value }))}
                        />
                      </label>
                      <label>Minor
                        <input
                          type="number"
                          inputMode="numeric"
                          min="0"
                          max="65535"
                          value={beaconConfig.minor}
                          disabled={beaconConfigLocked}
                          onChange={event => setBeaconConfig(config => ({ ...config, minor: event.target.value }))}
                        />
                      </label>
                    </>
                  )}
                  <label>Reachable signal (dBm)
                    <input
                      type="number"
                      inputMode="numeric"
                      min="-100"
                      max="-30"
                      value={beaconConfig.minRssi}
                      disabled={beaconConfigLocked}
                      onChange={event => setBeaconConfig(config => ({ ...config, minRssi: event.target.value }))}
                    />
                  </label>
                </div>
                <small>
                  {beaconConfig.format === 'ibeacon'
                    ? 'Configure the simulator as iBeacon with these exact values. Standard manufacturer frames are enabled without requesting GPS or location permission.'
                    : 'Configure the simulator to advertise this 128-bit service UUID. Use this privacy-safe fallback if iBeacon is not detected.'}
                  {' '}One-time scans stop after 30 seconds. Closed-app alerts use a low-power filtered scan and trigger only at or above the configured signal threshold.
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
            <span><span className="eyebrow">Updates</span><strong>Notifications</strong></span>
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
            <span><span className="eyebrow">Optional for today</span><strong>Boarding from a different stop today?</strong></span>
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
    </div>
  )
}
