import { useState } from 'react'
import type { EffectSlot } from '../audio/contracts.ts'
import { getSpec } from '../audio/contracts.ts'
import { PedalSlot } from './PedalSlot.tsx'

interface RackProps {
  slots: EffectSlot[]
  /** When set, only engaged pedals are rendered (the "active chain" view). */
  activeOnly?: boolean
  onToggle: (index: number) => void
  onAmount: (index: number, raw: number) => void
  onOpen: (index: number) => void
  onReorder: (from: number, to: number) => void
}

export function Rack({ slots, activeOnly, onToggle, onAmount, onOpen, onReorder }: RackProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const move = (index: number, dir: -1 | 1) => {
    const to = index + dir
    if (to < 0 || to >= slots.length) return
    onReorder(index, to)
  }

  const hasActive = slots.some((s) => s.enabled)

  return (
    <div className="rack">
      {slots.map((slot, index) =>
        // Keep the real index for callbacks/reorder; just hide bypassed slots.
        activeOnly && !slot.enabled ? null : (
          <PedalSlot
            key={slot.id}
            slot={slot}
            spec={getSpec(slot.id)}
            index={index}
            count={slots.length}
            dragging={dragIndex === index}
            dragOver={overIndex === index && dragIndex !== index}
            onToggle={() => onToggle(index)}
            onAmount={(raw) => onAmount(index, raw)}
            onOpen={() => onOpen(index)}
            onMove={(dir) => move(index, dir)}
            onDragStart={() => setDragIndex(index)}
            onDragEnter={() => setOverIndex(index)}
            onDrop={() => {
              if (dragIndex !== null && dragIndex !== index) onReorder(dragIndex, index)
              setDragIndex(null)
              setOverIndex(null)
            }}
            onDragEnd={() => {
              setDragIndex(null)
              setOverIndex(null)
            }}
          />
        ),
      )}
      {activeOnly && !hasActive && (
        <p className="rack-empty">No engaged pedals — tap a slot’s LED to bring one in.</p>
      )}
    </div>
  )
}
