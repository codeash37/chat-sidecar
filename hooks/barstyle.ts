// The terminal's bar styles, for the plan band and the subagent cards; `barStyle` in userConfig picks one. The desktop
// plan band stays an SVG. Pixel takes its idea (braille dots, denser toward the head) from claude-deck by nvr0x5 (MIT).
import { mix } from './band'
import { barParts } from './helpers'
import type { HelperPhase } from '../types'

export const BAR_STYLE_IDS = ['gradient', 'segments', 'line', 'dots', 'pixel'] as const
export type BarStyle = (typeof BAR_STYLE_IDS)[number]
export const BAR_STYLE_NAMES: Record<BarStyle, string> = { gradient: 'Gradient', segments: 'Segments', line: 'Line', dots: 'Dots', pixel: 'Pixel' }

/** One cell of a bar: its character, and its colour or dim. */
export type Cell = { ch: string; color?: string; dim?: boolean }
type Palette = { light: string; mid: string; deep: string }

/** Braille, sparse to full. */
const DOTS = '⡀⣀⣄⣤⣦⣶⣷⣿'

/** A steady 0..1 for cell `x` at `frame`: pixel's twinkle, the same on every drawing of one frame. */
function hash(x: number, frame: number): number {
  let h = Math.imul(x + 1, 374761393) ^ Math.imul(frame + 7, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** The glyphs of a style: done (gradient-coloured), the step in progress, and what is left (dim). */
const GLYPHS: Record<Exclude<BarStyle, 'dots' | 'pixel'>, { fill: string; live: string; rest: string }> = {
  gradient: { fill: '█', live: '▓', rest: '░' },
  segments: { fill: '▰', live: '▰', rest: '▱' },
  line: { fill: '━', live: '╸', rest: '─' },
}

/**
 * The plan band's track, `barW` cells: `done` of `total` steps, the next one in progress when `isLive`, which flashes
 * with `tick`. Dots draws one dot a step and falls back to segments when they don't fit.
 */
export function planCells(style: BarStyle, p: { done: number; total: number; isLive: boolean; barW: number; tick: number; palette: Palette }): Cell[] {
  const { done, total, isLive, barW, tick, palette } = p
  const n = Math.max(1, total)
  const flash = tick % 2 ? palette.mid : palette.light
  const shade = (i: number, of: number) => mix(palette.light, palette.deep, of > 1 ? i / (of - 1) : 1)

  if (style === 'dots' && n * 2 - 1 <= barW) {
    const cells: Cell[] = []
    for (let i = 0; i < n; i++) {
      if (i > 0) cells.push(i <= done ? { ch: '─', color: shade(i - 1, n) } : { ch: '┄', dim: true })
      cells.push(i < done ? { ch: '●', color: shade(i, n) } : i === done && isLive ? { ch: '◉', color: flash } : { ch: '○', dim: true })
    }
    return cells
  }

  const fillC = Math.round((barW * done) / n)
  const liveC = isLive ? Math.max(0, Math.round((barW * Math.min(n, done + 1)) / n) - fillC) : 0
  const restC = Math.max(0, barW - fillC - liveC)

  if (style === 'pixel') {
    // Denser toward the head, twinkling every other tick.
    const fill = Array.from({ length: fillC }, (_, x): Cell => {
      const t = (x + 1) / Math.max(fillC, 1)
      const d = (0.15 + 0.8 * t * t) * (0.6 + 0.4 * hash(x, tick >> 1))
      return { ch: DOTS[Math.min(DOTS.length - 1, Math.floor(d * DOTS.length))]!, color: shade(x, fillC) }
    })
    const live = Array.from({ length: liveC }, (_, x): Cell => ({ ch: DOTS[Math.floor(hash(fillC + x, tick) * 4)]!, color: flash }))
    return [...fill, ...live, ...Array.from({ length: restC }, (): Cell => ({ ch: '⠒', dim: true }))]
  }

  const g = GLYPHS[style === 'dots' ? 'segments' : style]
  return [
    ...Array.from({ length: fillC }, (_, i): Cell => ({ ch: g.fill, color: shade(i, fillC) })),
    // Line draws the step in progress as one head, the rest of its share as track.
    ...Array.from({ length: liveC }, (_, i): Cell => (style === 'line' && i > 0 ? { ch: g.rest, dim: true } : { ch: g.live, color: flash })),
    ...Array.from({ length: restC }, (): Cell => ({ ch: g.rest, dim: true })),
  ]
}

/** A subagent card's bar, `w` cells: the piece moving while it works (as `barParts`), full once it is over. */
export function agentParts(style: BarStyle, phase: HelperPhase, w: number, tick: number, seat: number): [string, string, string] {
  const [before, piece, after] = barParts(phase, w, tick, seat)
  if (style === 'gradient') return [before, piece, after]
  const track = { segments: '▱', line: '─', dots: '·', pixel: '⠒' }[style]
  const body =
    style === 'pixel'
      ? Array.from({ length: piece.length }, (_, x) => DOTS[4 + Math.floor(hash(x + seat * 31, tick) * 4)]).join('')
      : { segments: '▰', line: '━', dots: '●' }[style].repeat(piece.length)
  return [track.repeat(before.length), body, track.repeat(after.length)]
}
