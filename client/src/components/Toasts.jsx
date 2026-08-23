export default function Toasts({ toasts }) {
  return (
    <div className="toasts" aria-live="polite" aria-atomic="true">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.type}`} role={t.type === 'error' ? 'alert' : 'status'}>
          <span className="toast-icon" aria-hidden="true" />
          {t.message}
        </div>
      ))}
    </div>
  )
}
