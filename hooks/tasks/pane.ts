// From human-in-the-loop 0.1.8 by Tzafrir Rehan (MIT, see LICENSE in this folder), adapted for chat-sidecar: see UPSTREAM.md.
import type { Editing, Task } from '../../types'
import { MAX_OPTION, MAX_WHY, isActive } from './tasks'
import { ago, cellsOf, clip, printable } from './text'

/**
 * The longest title the pane and the transcript draw. `assign_task` takes
 * titles of at most MAX_TITLE characters; this bounds what an older version
 * or another session left in the store, never a title assigned now.
 */
export const MAX_SHOWN_TITLE = 300

/** The columns between two buttons in a row of them. */
export const BUTTON_GAP = 3

/** The fewest columns the terminal gives a focused field's text, however narrow the pane. */
const MIN_FIELD_COLUMNS = 12

/** What Tasks for me draws from: the tasks, which field is open, and what each row's words depend on. */
export type PaneView = {
  shown: readonly Task[]
  editing: Editing | null
  /** The draft in the open field. */
  draft: string
  nowMs: number
  sessionId: string
  isWorking: boolean
  /** The surface draws a text field (the mobile app draws none yet). */
  canType: boolean
  isFocused: boolean
}

/** A task's whole title, safe to draw. */
export function nameOf(task: Task): string {
  return printable(task.title, MAX_SHOWN_TITLE)
}

/** `#3 Rotate the token`: a task's number and its whole title. */
export function titleOf(task: Task): string {
  return `#${task.id} ${nameOf(task)}`
}

/** `  3m · from an earlier session`, drawn dim after an open task's title. */
export function ageOf(task: Task, view: Pick<PaneView, 'nowMs' | 'sessionId'>): string {
  const earlier = task.sessionId === view.sessionId ? '' : ' · from an earlier session'

  return `  ${ago(view.nowMs - task.createdMs)}${earlier}`
}

export function whyOf(task: Task): string {
  return printable(task.why, MAX_WHY)
}

export function doneWhenOf(task: Task): string | undefined {
  return task.doneWhen === undefined ? undefined : `Done when: ${printable(task.doneWhen, MAX_WHY)}`
}

/** A saved response's row: its task, and that it waits. */
export function savedOf(task: Task): string {
  return `${titleOf(task)} · not sent yet`
}

/** A task's buttons. No hotkeys: the sidecar takes the keys on any click (see `tasksSection`). */
export function actionsOf(task: Task, canType: boolean): { key: string; label: string; option?: string }[] {
  const choices =
    task.kind === 'choose' && task.options !== undefined
      ? task.options.map((option, i) => ({ key: `option-${i + 1}`, label: printable(option, MAX_OPTION), option }))
      : [{ key: 'done', label: 'Done' }]

  const typed = canType
    ? [
        { key: 'answer', label: task.kind === 'choose' ? 'Other…' : 'Answer…' },
        { key: 'reject', label: 'Reject…' },
      ]
    : [{ key: 'reject', label: 'Reject' }]

  return [...choices, ...typed]
}

/** A closed task's row in Answered: `✓ #3 Pick the database — Postgres`, `✗ … — reason`, `↩ … — withdrawn: reason`. */
export function answeredOf(task: Task): { glyph: string; color: string; text: string } {
  const said = (text: string | undefined) => (text === undefined || text === '' ? '' : ` — ${printable(text, MAX_WHY)}`)

  if (task.state === 'rejected') {
    return { glyph: '✗', color: 'red', text: `${titleOf(task)}${said(task.reason)}` }
  }

  if (task.state === 'withdrawn') {
    return { glyph: '↩', color: 'gray', text: `${titleOf(task)} — withdrawn${task.reason ? `: ${printable(task.reason, MAX_WHY)}` : ''}` }
  }

  return { glyph: '✓', color: 'green', text: `${titleOf(task)}${said(task.answer)}` }
}

// The terminal draws a field's label as `Answer: `.
export const ANSWER_LABEL = 'Answer'
export const REASON_LABEL = 'Reason'
export const REASON_PLACEHOLDER = 'Optional; Enter rejects it'
export const HELD =
  'This looks like a secret. Claude and the transcript on disk would see it. Put it where it belongs and press Done instead.'

export function answerPlaceholderOf(view: PaneView): string {
  if (!view.isWorking) {
    return 'Enter sends it to Claude'
  }

  return view.shown.filter(isActive).length > 1
    ? 'Enter saves it; Claude gets it with your other answers'
    : 'Enter saves it; Claude gets it when this turn ends'
}

/** The answer field's buttons. */
export function answerButtonsOf(view: PaneView): string[] {
  return [view.isWorking ? 'Send now' : 'Save for later', 'Long answer…', 'Cancel']
}

/** The key of task `id`'s field: its own, so no other task's draft, or the focus, lands in it. */
export function fieldKeyOf(field: Pick<Editing, 'id' | 'field'>): string {
  return `${field.field}-${field.id}`
}

/** What Enter does in a field, drawn beside it while it has the keys. */
export function submitLabelOf(field: Editing['field'], view: Pick<PaneView, 'isWorking'>): string {
  return field === 'reason' ? 'reject' : view.isWorking ? 'save' : 'send'
}

/**
 * The columns the terminal gives a focused field's text: the pane's body,
 * `columns` across, less the label (`Answer: `) and the hint (` ⏎ send`).
 */
export function fieldColumnsOf(label: string, submitLabel: string, columns: number): number {
  return Math.max(MIN_FIELD_COLUMNS, columns - cellsOf(`${label}: `) - cellsOf(` ⏎ ${submitLabel}`))
}

/** A placeholder cut to one row of its field, focused or not. */
export function placeholderOf(text: string, label: string, submitLabel: string, columns: number): string {
  return clip(text, fieldColumnsOf(label, submitLabel, columns))
}
