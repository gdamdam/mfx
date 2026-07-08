import { useEffect, useRef } from 'react'
import type { EffectSlot, EffectSpec, ParamSpec } from '../audio/contracts.ts'
import { clamp, FAMILY_LABELS } from '../audio/contracts.ts'
import { Knob } from './Knob.tsx'
import { ResponseGraph } from './ResponseGraph.tsx'
import { rawToNorm, normToRaw, formatParam } from './format.ts'

interface EffectModalProps {
  slot: EffectSlot
  spec: EffectSpec
  onParam: (key: string, raw: number) => void
  onToggle: () => void
  onClose: () => void
}

function Segmented({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec
  value: number
  onChange: (raw: number) => void
}) {
  const options = spec.options ?? []
  const current = clamp(Math.round(value), 0, options.length - 1)
  return (
    <div className="param param-seg">
      <span className="param-label">{spec.label}</span>
      <div className="seg" role="group" aria-label={spec.label}>
        {options.map((opt, i) => (
          <button
            key={opt}
            className={`seg-btn ${i === current ? 'is-on' : ''}`}
            aria-pressed={i === current}
            onClick={() => onChange(i)}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  )
}

export function EffectModal({ slot, spec, onParam, onToggle, onClose }: EffectModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // Focus the dialog on open, trap Tab within it, and restore focus to the
    // previously-focused element on close so the rack behind stays inert.
    const prev = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    dialog?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !dialog) return
      const focusables = dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [onClose])

  const famColor = spec.color
  const amountSpec = spec.params.find((p) => p.key === spec.amount)!
  const others = spec.params.filter((p) => p.key !== spec.amount)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${spec.name} settings`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{ ['--fam' as string]: famColor }}
      >
        <header className="modal-head">
          <div className="modal-title">
            <span className="modal-short mono-val">{spec.short}</span>
            <div>
              <h2>
                {spec.name}
                <span className="modal-fam">{FAMILY_LABELS[spec.family]}</span>
              </h2>
              <p className="modal-blurb">{spec.blurb}</p>
            </div>
          </div>
          <div className="modal-head-actions">
            <button
              className={`btn ${slot.enabled ? 'is-active' : ''}`}
              onClick={onToggle}
              aria-pressed={slot.enabled}
            >
              {slot.enabled ? 'On' : 'Bypassed'}
            </button>
            <button className="btn" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </header>

        <ResponseGraph spec={spec} slot={slot} />

        <div className="modal-body">
          <div className="modal-amount">
            <Knob
              value={rawToNorm(amountSpec, slot.params[spec.amount])}
              onChange={(n) => onParam(spec.amount, normToRaw(amountSpec, n))}
              label={amountSpec.label}
              display={formatParam(amountSpec, slot.params[spec.amount])}
              color={famColor}
              size={104}
              hero
            />
          </div>

          <div className="modal-params">
            {others.map((ps) =>
              ps.options ? (
                <Segmented
                  key={ps.key}
                  spec={ps}
                  value={slot.params[ps.key]}
                  onChange={(raw) => onParam(ps.key, raw)}
                />
              ) : (
                <div className="param" key={ps.key}>
                  <Knob
                    value={rawToNorm(ps, slot.params[ps.key])}
                    onChange={(n) => onParam(ps.key, normToRaw(ps, n))}
                    label={ps.label}
                    display={formatParam(ps, slot.params[ps.key])}
                    color={famColor}
                    size={56}
                  />
                </div>
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
