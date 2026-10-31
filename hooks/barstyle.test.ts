import { expect, test } from 'claude-code/testing'

import { BAR_STYLE_IDS, agentParts, planCells } from './barstyle'

const palette = { light: '#c4b5fd', mid: '#8b5cf6', deep: '#6d28d9' }
const text = (cells: { ch: string }[]) => cells.map(c => c.ch).join('')
const plan = (style: (typeof BAR_STYLE_IDS)[number], done: number, isLive = true, barW = 10, tick = 0) =>
  planCells(style, { done, total: 5, isLive, barW, tick, palette })

test('gradient keeps the band as it was: blocks done, the step in progress shaded, the rest light', () => {
  expect(text(plan('gradient', 3))).toBe('██████▓▓░░')
  expect(plan('gradient', 3)[0]?.color).toBe(palette.light)
  expect(plan('gradient', 3)[5]?.color).toBe(palette.deep)
  expect(plan('gradient', 3)[9]?.dim).toBe(true)
})

test('segments and line', () => {
  expect(text(plan('segments', 3))).toBe('▰▰▰▰▰▰▰▰▱▱')
  expect(text(plan('line', 3))).toBe('━━━━━━╸───')
  expect(text(plan('line', 0, false))).toBe('──────────')
  expect(text(plan('line', 5, false))).toBe('━━━━━━━━━━')
})

test('dots draw a dot a step, the one in progress flashing with the tick', () => {
  expect(text(plan('dots', 3))).toBe('●─●─●─◉┄○')
  expect(plan('dots', 3, true, 10, 0)[6]?.color).toBe(palette.light)
  expect(plan('dots', 3, true, 10, 1)[6]?.color).toBe(palette.mid)
  expect(text(plan('dots', 5, false))).toBe('●─●─●─●─●')
})

test('dots fall back to segments where a dot a step does not fit', () => {
  expect(text(planCells('dots', { done: 3, total: 9, isLive: false, barW: 10, tick: 0, palette }))).toBe('▰▰▰▱▱▱▱▱▱▱')
})

test('pixel: braille done, denser toward the head, steady for one tick, the rest a dim baseline', () => {
  const cells = plan('pixel', 3)
  expect(cells).toHaveLength(10)
  expect(cells.slice(0, 8).every(c => /[⠀-⣿]/.test(c.ch) && c.ch !== '⠒')).toBe(true)
  expect(cells.slice(8).map(c => [c.ch, c.dim])).toEqual([
    ['⠒', true],
    ['⠒', true],
  ])
  expect(text(plan('pixel', 3, true, 10, 4))).toBe(text(plan('pixel', 3, true, 10, 4)))
  expect(text(plan('pixel', 5, false, 20, 0)).at(-1)).not.toBe('⡀')
})

test('every style fills the track it is given', () => {
  for (const style of BAR_STYLE_IDS) {
    if (style === 'dots') continue
    for (const done of [0, 1, 3, 5]) expect(plan(style, done, done < 5), `${style} ${done}`).toHaveLength(10)
  }
})

test('a subagent bar takes the style: the piece moves while it works, full once it is over', () => {
  for (const style of BAR_STYLE_IDS) {
    const [a, b, c] = agentParts(style, 'working', 12, 3, 0)
    expect(a.length + b.length + c.length, style).toBe(12)
    expect(agentParts(style, 'done', 12, 3, 0).join('').length, style).toBe(12)
  }
  expect(agentParts('segments', 'done', 4, 0, 0)).toEqual(['', '▰▰▰▰', ''])
  expect(agentParts('line', 'working', 12, 3, 0).join('')).toMatch(/^─*━+─*$/)
  expect(agentParts('gradient', 'working', 12, 3, 0).join('')).toMatch(/^░*█+░*$/)
})
