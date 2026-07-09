interface StartOverlayProps {
  onStart: () => void
  error: string | null
}

export function StartOverlay({ onStart, error }: StartOverlayProps) {
  return (
    <div className="start">
      <div className="start-card">
        <div className="start-mark" aria-hidden="true">
          <img src={`${import.meta.env.BASE_URL}mfx.svg`} width={96} height={96} alt="" />
        </div>
        <h1 className="start-word">
          m<b>fx</b>
        </h1>
        <p className="start-hook">Your instrument in. Twenty-five pedals. Play the effects.</p>

        <button className="btn power" onClick={onStart}>
          ⏻ Power on
        </button>

        <ul className="start-notes">
          <li>
            <b>Great without a mic.</b> Process loops, files, browser-tab audio, and mbus sources —
            or use mfx as a wet send / reamp over your own dry signal.
          </li>
          <li>
            <b>Playing live?</b> The browser adds real round-trip latency (tightest on Chromium with
            a wired input). Monitor your dry signal through your interface and let mfx add the wet —
            it&apos;s an effects lab, not a zero-latency amp.
          </li>
          <li>
            <b>Use headphones.</b> Monitoring stays muted on a microphone so a mic → speaker
            feedback loop can&apos;t build. Unmute only when it&apos;s safe.
          </li>
          <li>Everything runs locally — no account, no upload, no telemetry.</li>
        </ul>

        {error && <p className="start-error" role="alert">{error}</p>}
      </div>
    </div>
  )
}
