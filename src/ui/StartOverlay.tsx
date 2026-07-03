interface StartOverlayProps {
  onStart: () => void
  error: string | null
}

export function StartOverlay({ onStart, error }: StartOverlayProps) {
  return (
    <div className="start">
      <div className="start-card">
        <div className="start-mark" aria-hidden="true">
          <img src="/mfx.svg" width={96} height={96} alt="" />
        </div>
        <h1 className="start-word">
          m<b>fx</b>
        </h1>
        <p className="start-hook">Your instrument in. Ten pedals. Play the effects.</p>

        <button className="btn power" onClick={onStart}>
          ⏻ Power on
        </button>

        <ul className="start-notes">
          <li>
            <b>Use headphones.</b> Monitoring stays muted on a microphone so a mic → speaker
            feedback loop can&apos;t build. Unmute only when it&apos;s safe.
          </li>
          <li>Everything runs locally — no account, no upload, no telemetry.</li>
          <li>Best on Chromium with a wired input. There is real, honest latency.</li>
        </ul>

        {error && <p className="start-error" role="alert">{error}</p>}
      </div>
    </div>
  )
}
