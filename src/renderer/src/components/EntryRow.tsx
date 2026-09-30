import { useEffect, useRef, useState } from 'react'
import type { ShellId } from '@shared/types'
import { highlight } from '../fuzzy'

export interface LauncherRow {
  key: string
  entryId: string
  title: string
  path: string
  subtitle: string
  badge: string
  meta: string
  titleIndices: number[]
  pathIndices: number[]
  /**
   * Set only on the rows the shell picker shows. It travels on the row so the
   * key handler passes the choice along instead of parsing it back out of the
   * key string, and so the row's own key stays unique per shell.
   */
  shell?: ShellId
}

/**
 * What the row is currently reporting about the launch it was asked for.
 *
 * Every state here exists because the previous version looked identical whether
 * the click was still starting something, had worked, or had failed.
 */
export type RowState = 'idle' | 'launching' | 'done' | 'failed'

interface Props {
  row: LauncherRow
  selected: boolean
  index: number
  state: RowState
  /**
   * Wording for the state badge. It comes from the caller because the same
   * three states read differently for a fresh launch and for a repeat the main
   * process swallowed ("已打开" versus "已在启动").
   */
  stateLabel: string
  onHover: () => void
  onOpen: () => void
  /**
   * 'path' is the synthetic row that opens a directory which is not saved;
   * 'save' is the one that keeps it. Both sit under a typed path, so they share
   * a title and differ only in what the subtitle says they will do.
   */
  variant?: 'path' | 'save'
}

function renderHighlighted(text: string, indices: number[]) {
  return highlight(text, indices).map((part, i) =>
    typeof part === 'string' ? (
      <span key={i}>{part}</span>
    ) : (
      <mark key={i}>{part.hit}</mark>
    )
  )
}

export default function EntryRow({
  row,
  selected,
  index,
  state,
  stateLabel,
  onHover,
  onOpen,
  variant
}: Props) {
  const [pressed, setPressed] = useState(false)
  const pressTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current)
    },
    []
  )

  /**
   * A press is acknowledged the instant the mouse goes down, because the
   * launch starts on mousedown and the row is about to be busy for a moment.
   *
   * The self-clearing timer matters: the window loses focus and the mouseup is
   * never delivered, which would otherwise leave the row stuck in its pressed
   * style the next time the launcher appears.
   */
  const flashPress = () => {
    setPressed(true)
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current)
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null
      setPressed(false)
    }, 180)
  }

  const className = [
    'row',
    selected ? 'selected' : '',
    state !== 'idle' ? state : '',
    pressed ? 'pressed' : '',
    variant ? `${variant}-row` : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={className}
      role="option"
      aria-selected={selected}
      aria-busy={state === 'launching'}
      onMouseEnter={onHover}
      onMouseDown={(event) => {
        // mousedown, not click: the launcher hides on blur, and a click would
        // arrive after the window already lost focus.
        event.preventDefault()
        flashPress()
        onOpen()
      }}
    >
      {/* Only the first nine rows get a number, because only 1-9 are bound to
          a key. Showing "12" on the twelfth row would promise a shortcut that
          does not exist, and with a long list most of it would be lies. */}
      <div className="row-index">{selected || index > 8 ? '' : index + 1}</div>
      <div className="row-main">
        <div className="row-title">{renderHighlighted(row.title, row.titleIndices)}</div>
        <div className="row-path">{renderHighlighted(row.subtitle, row.pathIndices)}</div>
      </div>
      <div className="row-side">
        <span className="badge">{row.badge}</span>
        {state === 'idle' ? (
          <span className="meta">{row.meta}</span>
        ) : (
          // The state takes over the "last used" slot: it is the only thing in
          // this row the user needs right now, and reusing the space keeps the
          // row from shifting as the state changes.
          <span className={`row-state ${state}`}>
            {state === 'launching' ? <span className="spin" /> : stateLabel}
          </span>
        )}
      </div>
    </div>
  )
}
