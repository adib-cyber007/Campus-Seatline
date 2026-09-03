import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

const stateLabels = {
  soft_hold: 'Soft Hold',
  seats_occupied: 'Seats Occupied'
}

export default function RiderManifestDialog({ target, refreshKey, onDismiss }) {
  const dialogRef = useRef(null)
  const [manifest, setManifest] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal()
  }, [])

  useEffect(() => {
    let current = true
    setError('')
    api(target.endpoint)
      .then(data => { if (current) setManifest(data) })
      .catch(requestError => { if (current) setError(requestError.message) })
    return () => { current = false }
  }, [target.endpoint, refreshKey])

  const close = () => dialogRef.current?.close()
  const label = stateLabels[target.state]
  const correctionDelta = manifest?.state === 'seats_occupied'
    ? manifest.liveCount - manifest.reportCount
    : 0

  return (
    <dialog ref={dialogRef} className="rider-manifest" aria-labelledby="manifest-title" onClose={onDismiss}>
      <header className="manifest-head">
        <div>
          <h2 id="manifest-title">{label} manifest</h2>
          <p>{target.busName}{manifest?.tripDirection ? ` / ${manifest.tripDirection} trip / ${manifest.tripDate}` : ''}</p>
        </div>
        <button type="button" className="manifest-close" aria-label="Close rider manifest" onClick={close}>×</button>
      </header>

      {error ? (
        <div className="manifest-message error" role="alert"><strong>Manifest unavailable</strong><p>{error}</p></div>
      ) : !manifest ? (
        <div className="manifest-message" role="status"><span className="spinner dark" /> Loading current trip riders</div>
      ) : !manifest.tripId ? (
        <div className="manifest-message"><strong>No active trip</strong><p>There are no current rider states for this bus.</p></div>
      ) : (
        <>
          <dl className="manifest-totals">
            <div><dt>Live count</dt><dd>{manifest.liveCount}</dd></div>
            <div><dt>Named rider reports</dt><dd>{manifest.reportCount}</dd></div>
          </dl>
          {correctionDelta !== 0 && (
            <p className="manifest-correction">
              The live Seats Occupied total is {Math.abs(correctionDelta)} {correctionDelta > 0 ? 'higher' : 'lower'} than the named reports because of the current audit-logged Incharge correction.
            </p>
          )}
          {manifest.riders.length > 0 ? (
            <ol className="manifest-riders">
              {manifest.riders.map(rider => (
                <li key={rider.id}>
                  <span className="manifest-sequence" aria-hidden="true" />
                  <span><strong>{rider.name}</strong><small>{rider.identifier}</small></span>
                  <span className={`manifest-state ${rider.state}`}>{stateLabels[rider.state]}</span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="manifest-message"><strong>No riders in this state</strong><p>The active trip has no matching rider reports.</p></div>
          )}
        </>
      )}
    </dialog>
  )
}
