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
}

interface Props {
  row: LauncherRow
  selected: boolean
  index: number
  onHover: () => void
  onOpen: () => void
  /** 'path' is the synthetic row that opens a directory which is not saved. */
  variant?: 'path'
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

export default function EntryRow({ row, selected, index, onHover, onOpen, variant }: Props) {
  return (
    <div
      className={`row${selected ? ' selected' : ''}${variant === 'path' ? ' path-row' : ''}`}
      onMouseEnter={onHover}
      onMouseDown={(event) => {
        // mousedown, not click: the launcher hides on blur, and a click would
        // arrive after the window already lost focus.
        event.preventDefault()
        onOpen()
      }}
    >
      <div className="row-index">{selected ? '' : index + 1}</div>
      <div className="row-main">
        <div className="row-title">{renderHighlighted(row.title, row.titleIndices)}</div>
        <div className="row-path">{renderHighlighted(row.subtitle, row.pathIndices)}</div>
      </div>
      <div className="row-side">
        <span className="badge">{row.badge}</span>
        <span className="meta">{row.meta}</span>
      </div>
    </div>
  )
}
