import { useEffect, useState } from 'react'
import type { EffectSlot, EffectSpec } from '../audio/contracts.ts'
import { Knob } from './Knob.tsx'
import { rawToNorm, normToRaw, formatParam } from './format.ts'

interface PedalSlotProps {
  slot: EffectSlot
  spec: EffectSpec
  index: number
  count: number
  dragging: boolean
  dragOver: boolean
  onToggle: () => void
  onAmount: (raw: number) => void
  onOpen: () => void
  onMove: (dir: -1 | 1) => void
  onDragStart: () => void
  onDragEnter: () => void
  onDrop: () => void
  onDragEnd: () => void
}

export function PedalSlot({
  slot,
  spec,
  index,
  count,
  dragging,
  dragOver,
  onToggle,
  onAmount,
  onOpen,
  onMove,
  onDragStart,
  onDragEnter,
  onDrop,
  onDragEnd,
}: PedalSlotProps) {
  const amountSpec = spec.params.find((p) => p.key === spec.amount)!
  const famColor = `var(--fam-${spec.family})`

  // While the knob is being turned, suppress the pedal's native reorder drag —
  // otherwise a knob drag also picks up the whole pedal. The dragstart event
  // targets this draggable div (not the inner knob), so we can't cancel it from
  // the knob; instead we flip `draggable` off for the duration of the gesture.
  const [knobHeld, setKnobHeld] = useState(false)
  useEffect(() => {
    if (!knobHeld) return
    const release = () => setKnobHeld(false)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [knobHeld])

  return (
    <div
      className={`pedal ${slot.enabled ? 'on' : 'off'} ${dragging ? 'dragging' : ''} ${
        dragOver ? 'drag-over' : ''
      }`}
      draggable={!knobHeld}
      onDragStart={(e) => {
        // Firefox refuses to start an HTML5 drag unless data is set.
        e.dataTransfer.setData('text/plain', String(index))
        onDragStart()
      }}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        onDrop()
      }}
      onDragEnd={onDragEnd}
      style={{ ['--fam' as string]: famColor }}
    >
      <div className="pedal-top">
        <button
          className="led-btn"
          onClick={onToggle}
          aria-pressed={slot.enabled}
          aria-label={`${spec.name} ${slot.enabled ? 'on' : 'off'}`}
          title={slot.enabled ? 'On — click to bypass' : 'Bypassed — click to engage'}
        >
          <span className="led" />
        </button>
        <span className="pedal-slotno mono-val">{String(index + 1).padStart(2, '0')}</span>
      </div>

      <button className="pedal-face" onClick={onOpen} title={spec.blurb}>
        <span className="pedal-short">{spec.short}</span>
        <span className="pedal-name">{spec.name}</span>
      </button>

      <div
        className="pedal-knob"
        onPointerDown={() => setKnobHeld(true)}
        onDragStart={(e) => e.preventDefault()}
        draggable={false}
      >
        <Knob
          value={rawToNorm(amountSpec, slot.params[spec.amount])}
          onChange={(n) => onAmount(normToRaw(amountSpec, n))}
          label={amountSpec.label}
          display={formatParam(amountSpec, slot.params[spec.amount])}
          color={famColor}
          size={62}
        />
      </div>

      <div className="pedal-reorder">
        <button
          className="mini"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          aria-label={`Move ${spec.name} earlier`}
        >
          ‹
        </button>
        <button className="mini edit" onClick={onOpen} aria-label={`Edit ${spec.name}`}>
          edit
        </button>
        <button
          className="mini"
          onClick={() => onMove(1)}
          disabled={index === count - 1}
          aria-label={`Move ${spec.name} later`}
        >
          ›
        </button>
      </div>
    </div>
  )
}
