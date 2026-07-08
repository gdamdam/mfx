import type { Macro } from '../audio/contracts.ts'
import { Knob } from './Knob.tsx'

interface MacroBankProps {
  macros: Macro[]
  onChange: (index: number, value: number) => void
}

// Each macro wears a tint drawn from the family it mostly drives.
const TINTS = ['var(--fam-core)', 'var(--fam-modulation)', 'var(--fam-ambient)', 'var(--fam-creative)']

export function MacroBank({ macros, onChange }: MacroBankProps) {
  return (
    <div className="macros">
      {macros.map((m, i) => (
        <div className="macro" key={m.label}>
          <Knob
            value={m.value}
            onChange={(v) => onChange(i, v)}
            label={m.label}
            display={`${Math.round(m.value * 100)}%`}
            color={TINTS[i % TINTS.length]}
            size={66}
          />
        </div>
      ))}
    </div>
  )
}
