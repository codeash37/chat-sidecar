// The plan band's colours and its desktop drawing. `mix` and BAND_COLOR_IDS are used by the kept parse.ts and barstyle.ts.

/** The band colour ids, in this order (parse.test pins it through its problem text). */
export const BAND_COLOR_IDS = ['purple', 'green', 'burgundy', 'navy', 'orange'] as const
export type BandColor = (typeof BAND_COLOR_IDS)[number]

export const BAND_COLOR_NAMES: Record<BandColor, string> = {
  purple: 'Purple',
  green: 'Bottle green',
  burgundy: 'Burgundy',
  navy: 'Navy',
  orange: 'Orange',
}

/** One band palette: the fill's three tones, and the track and tick tones for light and dark mode. */
export type BandPalette = {
  light: string
  mid: string
  deep: string
  track: { light: string; dark: string }
  tick: { light: string; dark: string }
}

export const PALETTES: Record<BandColor, BandPalette> = {
  purple: { light: '#c4b5fd', mid: '#8b5cf6', deep: '#6d28d9', track: { light: '#ede9fe', dark: '#2e1065' }, tick: { light: '#ddd6fe', dark: '#4c1d95' } },
  green: { light: '#86c5a0', mid: '#2f7d55', deep: '#14532d', track: { light: '#e3f1e8', dark: '#0f2a1c' }, tick: { light: '#c3e0cd', dark: '#1d4a32' } },
  burgundy: { light: '#e59aa8', mid: '#a3324a', deep: '#6b1028', track: { light: '#f8e4e8', dark: '#2e0a14' }, tick: { light: '#efc6ce', dark: '#4f1424' } },
  navy: { light: '#93b4e8', mid: '#2f5aa8', deep: '#14306b', track: { light: '#e2eaf8', dark: '#0b1a36' }, tick: { light: '#c3d4f0', dark: '#1c3466' } },
  orange: { light: '#fdc28a', mid: '#f08a24', deep: '#b45309', track: { light: '#fff0e0', dark: '#3a1d06' }, tick: { light: '#fbd9b5', dark: '#5c300b' } },
}

/** A known band colour id, else purple. */
export function bandColorOf(id: string): BandColor {
  return (BAND_COLOR_IDS as readonly string[]).includes(id) ? (id as BandColor) : 'purple'
}

/** The colour between two `#rrggbb` colours, `t` from 0 to 1, per channel linear and rounded, as lowercase `#rrggbb`. */
export function mix(a: string, b: string, t: number): string {
  const k = Math.min(1, Math.max(0, t))
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  let out = '#'
  for (let i = 0; i < 3; i++) {
    const v = Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * k)
    out += Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0')
  }
  return out
}

/** The plan as the band draws it. */
export type BandPlan = { title: string; done: number; total: number; isLive: boolean; liveIndex: number }

/** `Tasks d/n` and the rounded percent. */
export function bandCounts(p: Pick<BandPlan, 'done' | 'total'>): { count: string; percent: string } {
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0
  return { count: `Tasks ${p.done}/${p.total}`, percent: `${pct}%` }
}

/** The desktop band's width in px: about 8 px a column, less room for the count button and ✕, clamped. */
export function bandWidthPx(bodyColumns: number | undefined, reserveColumns: number): number {
  const cols = bodyColumns ?? 100
  return Math.min(1600, Math.max(180, Math.round((cols - reserveColumns) * 8)))
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The desktop band: a dot, the title, a rounded track filled done/total with a light → mid → deep gradient, ticks
 * between steps, a soft pulse over the step in progress, a `Tasks d/n` pill at the fill head and the percent on the
 * right. Motion is off under reduced motion.
 */
export function bandSvg(plan: BandPlan, color: BandColor, width: number): string {
  const p = PALETTES[color]
  const h = 24
  const { count, percent } = bandCounts(plan)
  const titleW = Math.min(220, Math.max(48, plan.title.length * 7 + 8))
  const pctW = 40
  const x0 = 18 + titleW
  const trackW = Math.max(40, width - x0 - pctW - 6)
  const n = Math.max(1, plan.total)
  const fillW = (trackW * plan.done) / n
  const ticks = Array.from({ length: n - 1 }, (_, i) => x0 + (trackW * (i + 1)) / n)
    .map(x => `<line class="tick" x1="${x.toFixed(1)}" y1="9" x2="${x.toFixed(1)}" y2="15"/>`)
    .join('')
  const pulse =
    plan.isLive && plan.liveIndex < n
      ? `<rect class="pulse" x="${(x0 + (trackW * plan.liveIndex) / n).toFixed(1)}" y="8" width="${(trackW / n).toFixed(1)}" height="8" rx="4" fill="${p.mid}"/>`
      : ''
  const pillW = count.length * 6 + 10
  const pillX = Math.min(x0 + trackW - pillW, Math.max(x0, x0 + fillW - pillW / 2))
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">`,
    '<defs>',
    `<linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${p.light}"/><stop offset="0.5" stop-color="${p.mid}"/><stop offset="1" stop-color="${p.deep}"/></linearGradient>`,
    '<style>',
    `.track{fill:${p.track.light}}.tick{stroke:${p.tick.light};stroke-width:1}.t{fill:#1f1f1f}`,
    `@media (prefers-color-scheme:dark){.track{fill:${p.track.dark}}.tick{stroke:${p.tick.dark}}.t{fill:#f2f2f2}}`,
    '.pulse{opacity:.25;animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.6}}',
    '@media (prefers-reduced-motion:reduce){.pulse{animation:none}}',
    '</style>',
    '</defs>',
    `<circle cx="7" cy="12" r="4" fill="${p.deep}"/>`,
    `<text class="t" x="16" y="16" font-family="system-ui,sans-serif" font-size="12" font-weight="600">${esc(plan.title.slice(0, 30))}</text>`,
    `<rect class="track" x="${x0}" y="8" width="${trackW}" height="8" rx="4"/>`,
    fillW > 0 ? `<rect x="${x0}" y="8" width="${fillW.toFixed(1)}" height="8" rx="4" fill="url(#g)"/>` : '',
    ticks,
    pulse,
    `<rect x="${pillX.toFixed(1)}" y="3" width="${pillW}" height="18" rx="9" fill="${p.deep}"/>`,
    `<text x="${(pillX + pillW / 2).toFixed(1)}" y="15.5" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#ffffff">${esc(count)}</text>`,
    `<text class="t" x="${width - 4}" y="16" text-anchor="end" font-family="system-ui,sans-serif" font-size="11">${percent}</text>`,
    '</svg>',
  ].join('')
}

/** The settings screen's colour chips are drawn in a palette's middle tone. */
export function midOf(color: BandColor): string {
  return PALETTES[color].mid
}
