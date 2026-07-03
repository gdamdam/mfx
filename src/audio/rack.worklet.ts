/**
 * rack.worklet.ts — the real-time chain runner.
 *
 * Holds one instance of every effect core, processes the enabled slots in the
 * order the main thread sends, applies the master dry/wet, and reports peak
 * meters back at ~30 Hz. Modulation (macros + XY) is already folded in on the
 * main thread (see resolve.ts); this processor just runs the chain.
 *
 * The output limiter is a native DynamicsCompressorNode wired after this node
 * in the engine graph, so it is always last regardless of rack order.
 */
import type {
  EffectId,
  MainToWorkletMessage,
  MeterMessage,
  RackState,
} from './contracts.ts'
import { Drive } from './dsp/drive.ts'
import { Comp as Compressor } from './dsp/comp.ts'
import { Filter } from './dsp/filter.ts'
import { Chorus } from './dsp/chorus.ts'
import { Flanger } from './dsp/flanger.ts'
import { Phaser } from './dsp/phaser.ts'
import { Tremolo } from './dsp/tremolo.ts'
import { Delay } from './dsp/delay.ts'
import { Reverb } from './dsp/reverb.ts'
import { Bitcrusher } from './dsp/bitcrusher.ts'
import { RingMod } from './dsp/ringmod.ts'
import { Freeze } from './dsp/freeze.ts'

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor,
): void

/** Structural view of a core so the chain loop stays uniform. */
interface EffectCore {
  setParams(p: Record<string, number>): void
  processInto(left: number, right: number, out: Float64Array): void
  reset(): void
}

class RackProcessor extends AudioWorkletProcessor {
  private readonly cores: Record<EffectId, EffectCore>
  private readonly delay: Delay
  private state: RackState | null = null
  private readonly tmp = new Float64Array(2)

  // metering
  private inPeak = 0
  private outPeak = 0
  private framesToMeter = 0
  private readonly meterInterval: number

  constructor() {
    super()
    this.delay = new Delay(sampleRate)
    this.cores = {
      drive: new Drive(sampleRate) as unknown as EffectCore,
      comp: new Compressor(sampleRate) as unknown as EffectCore,
      filter: new Filter(sampleRate) as unknown as EffectCore,
      chorus: new Chorus(sampleRate) as unknown as EffectCore,
      flanger: new Flanger(sampleRate) as unknown as EffectCore,
      phaser: new Phaser(sampleRate) as unknown as EffectCore,
      tremolo: new Tremolo(sampleRate) as unknown as EffectCore,
      delay: this.delay as unknown as EffectCore,
      reverb: new Reverb(sampleRate) as unknown as EffectCore,
      bitcrusher: new Bitcrusher(sampleRate) as unknown as EffectCore,
      ringmod: new RingMod(sampleRate) as unknown as EffectCore,
      freeze: new Freeze(sampleRate) as unknown as EffectCore,
    }
    // report meters ~30 times/second
    this.meterInterval = Math.max(1, Math.floor(sampleRate / 30 / 128))

    this.port.onmessage = (event: MessageEvent<MainToWorkletMessage>) => {
      const msg = event.data
      if (msg.type === 'rack') {
        this.state = msg.state
        this.delay.setTempo(msg.state.tempo)
      } else if (msg.type === 'reset') {
        for (const id of Object.keys(this.cores) as EffectId[]) {
          this.cores[id].reset()
        }
      }
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
  ): boolean {
    const input = inputs[0]
    const output = outputs[0]
    const outL = output[0]
    const outR = output[1] ?? output[0]
    const frames = outL.length

    const state = this.state
    if (!state) {
      // No patch yet — pass through silence-safe.
      for (let i = 0; i < frames; i++) {
        outL[i] = 0
        if (output[1]) outR[i] = 0
      }
      return true
    }

    // Apply params + enabled flags once per block (cheap; cores smooth).
    for (const slot of state.slots) {
      const core = this.cores[slot.id]
      if (core) core.setParams(slot.params)
    }

    const inCh0 = input && input[0] ? input[0] : null
    const inCh1 = input && input[1] ? input[1] : inCh0
    const gain = state.inputGain
    const mix = state.mix
    const tmp = this.tmp
    const slots = state.slots

    for (let i = 0; i < frames; i++) {
      const dryL = (inCh0 ? inCh0[i] : 0) * gain
      const dryR = (inCh1 ? inCh1[i] : 0) * gain

      let l = dryL
      let r = dryR
      for (let s = 0; s < slots.length; s++) {
        const slot = slots[s]
        if (!slot.enabled) continue
        this.cores[slot.id].processInto(l, r, tmp)
        l = tmp[0]
        r = tmp[1]
      }

      const mixedL = dryL * (1 - mix) + l * mix
      const mixedR = dryR * (1 - mix) + r * mix
      outL[i] = mixedL
      if (output[1]) outR[i] = mixedR

      const ain = Math.max(Math.abs(dryL), Math.abs(dryR))
      const aout = Math.max(Math.abs(mixedL), Math.abs(mixedR))
      if (ain > this.inPeak) this.inPeak = ain
      if (aout > this.outPeak) this.outPeak = aout
    }

    if (--this.framesToMeter <= 0) {
      this.framesToMeter = this.meterInterval
      const meter: MeterMessage = {
        type: 'meter',
        inPeak: this.inPeak,
        outPeak: this.outPeak,
        reduction: 0,
      }
      this.port.postMessage(meter)
      // decay peaks so the meter falls back
      this.inPeak *= 0.6
      this.outPeak *= 0.6
    }

    return true
  }
}

registerProcessor('mfx-rack', RackProcessor as unknown as typeof AudioWorkletProcessor)
