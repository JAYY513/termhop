import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Config, Entry, HistoryItem, OpenTarget, PlacementMode, ShellId } from '@shared/types'
import { SHELL_META, api, entryTitle, formatAgo, shortPath } from '../api'
import { matchEntry } from '../fuzzy'
import EntryRow, { type LauncherRow } from './EntryRow'

interface Props {
  config: Config
  onConfig: (config: Config) => void
}

interface Section {
  name: string
  rows: LauncherRow[]
}

const ALL_SHELLS: ShellId[] = ['pwsh', 'powershell', 'cmd', 'wt']

/** C:\work\thing, D:\a\b, ~/dev/app, ./sub — anything path shaped. */
const PATH_LIKE = /^(?:[a-zA-Z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/])/

function buildRow(entry: Entry, last: HistoryItem | undefined, titleIndices: number[], pathIndices: number[]): LauncherRow {
  const shell = entry.lastShell ?? entry.defaultShell
  return {
    key: entry.id,
    entryId: entry.id,
    title: entryTitle(entry),
    path: entry.path,
    subtitle: shortPath(entry.path),
    badge: SHELL_META[shell]?.badge ?? shell,
    meta: formatAgo(last?.at ?? 0),
    titleIndices,
    pathIndices
  }
}

/** Renders a path-ish input as the row that opens a terminal there. */
function pathRow(query: string): LauncherRow {
  return {
    key: '__path__',
    entryId: '',
    title: query,
    path: query,
    subtitle: '在此路径打开终端（不会保存）',
    badge: 'open',
    meta: 'Enter',
    titleIndices: [],
    pathIndices: []
  }
}

export default function Launcher({ config, onConfig }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [placement, setPlacement] = useState<PlacementMode>('cursor')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api
      .getPlacement()
      .then((value) => setPlacement(value.mode))
      .catch(() => undefined)
  }, [])

  const lastUsed = useMemo(() => {
    const map = new Map<string, HistoryItem>()
    for (const item of config.history) {
      if (!map.has(item.entryId)) map.set(item.entryId, item)
    }
    return map
  }, [config.history])

  const sections = useMemo<Section[]>(() => {
    const trimmed = query.trim()

    if (trimmed) {
      const rows = config.entries
        .map((entry) => {
          const match = matchEntry(trimmed, entryTitle(entry), entry.path)
          return match ? { entry, match } : null
        })
        .filter((item): item is { entry: Entry; match: NonNullable<ReturnType<typeof matchEntry>> } => item !== null)
        .sort((a, b) => b.match.score - a.match.score || a.entry.order - b.entry.order)
        .map(({ entry, match }) => buildRow(entry, lastUsed.get(entry.id), match.titleIndices, match.pathIndices))

      // A saved entry is more likely to be what the user meant than a raw path.
      if (PATH_LIKE.test(trimmed)) rows.push(pathRow(trimmed))
      return [{ name: '', rows }]
    }

    const result: Section[] = []
    const recentIds = config.history.map((item) => item.entryId).slice(0, config.settings.recentCount)
    const recentRows = recentIds
      .map((id) => config.entries.find((entry) => entry.id === id))
      .filter((entry): entry is Entry => Boolean(entry))
      .map((entry) => buildRow(entry, lastUsed.get(entry.id), [], []))
    if (recentRows.length) result.push({ name: '最近', rows: recentRows })

    // An entry that is already in 最近 is not repeated under its group, or the
    // same row shows up twice and looks like a bug.
    const recentSet = new Set(recentRows.map((row) => row.entryId))
    const inGroups = (entry: Entry) => !recentSet.has(entry.id)

    for (const group of config.groups) {
      const rows = config.entries
        .filter((entry) => entry.groupId === group.id && inGroups(entry))
        .sort((a, b) => a.order - b.order)
        .map((entry) => buildRow(entry, lastUsed.get(entry.id), [], []))
      if (rows.length) result.push({ name: group.name, rows })
    }

    const ungrouped = config.entries
      .filter((entry) => !entry.groupId && inGroups(entry))
      .sort((a, b) => a.order - b.order)
      .map((entry) => buildRow(entry, lastUsed.get(entry.id), [], []))
    if (ungrouped.length) result.push({ name: '未分组', rows: ungrouped })

    return result
  }, [config, lastUsed, query])

  const flatRows = useMemo(() => sections.flatMap((section) => section.rows), [sections])
  const pathSelected = flatRows[selected]?.key === '__path__'

  // The window is sized to its content. Without this a single entry left a
  // 300px void below it, which read as a broken layout. Debounced so typing
  // does not make the window twitch on every keystroke.
  useEffect(() => {
    const node = innerRef.current
    if (!node) return
    const timer = window.setTimeout(() => {
      const content = node.scrollHeight
      api.resizeLauncher(content)
    }, 90)
    return () => window.clearTimeout(timer)
  }, [sections, error, placement])

  useEffect(() => {
    setSelected(0)
  }, [query])

  useEffect(() => {
    listRef.current?.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' })
  }, [selected, flatRows])

  useEffect(() => {
    const offShown = api.on('launcher:shown', () => {
      setQuery('')
      setSelected(0)
      setError(null)
      inputRef.current?.focus()
    })
    const offConfig = api.on('config:changed', (next) => onConfig(next))
    return () => {
      offShown()
      offConfig()
    }
  }, [onConfig])

  const runRow = useCallback(
    async (row: LauncherRow, target: OpenTarget) => {
      setError(null)
      if (row.key === '__path__') {
        const result = await api.openPath(row.path)
        if (!result.ok) setError(result.error ?? '启动失败')
        return
      }
      const result = await api.openEntry(row.entryId, target)
      if (!result.ok) setError(result.error ?? '启动失败')
    },
    []
  )

  const openNextShell = useCallback(
    (row: LauncherRow) => {
      if (row.key === '__path__') {
        void runRow(row, 'last')
        return
      }
      const entry = config.entries.find((item) => item.id === row.entryId)
      const current = entry?.lastShell ?? entry?.defaultShell ?? 'powershell'
      const index = ALL_SHELLS.indexOf(current)
      const next = ALL_SHELLS[(index + 1) % ALL_SHELLS.length]
      void runRow(row, next)
    },
    [config.entries, runRow]
  )

  const restoreCursorPlacement = () => {
    if (placement === 'cursor') return
    void api.setPlacementMode('cursor').then(() => setPlacement('cursor'))
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        api.hideLauncher()
        return
      }
      if (event.key === 'ArrowDown' || (event.key === 'p' && event.ctrlKey)) {
        event.preventDefault()
        setSelected((prev) => (flatRows.length ? (prev + 1) % flatRows.length : 0))
        return
      }
      if (event.key === 'ArrowUp' || (event.key === 'n' && event.ctrlKey)) {
        event.preventDefault()
        setSelected((prev) => (flatRows.length ? (prev - 1 + flatRows.length) % flatRows.length : 0))
        return
      }
      if (event.key === ',' && event.ctrlKey) {
        event.preventDefault()
        api.openSettings()
        return
      }
      if (event.key === 'n' && event.ctrlKey) {
        event.preventDefault()
        api.beginAddEntry()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const row = flatRows[selected]
        if (!row) return
        if (event.altKey) void runRow(row, 'reveal')
        else if (event.ctrlKey) void runRow(row, 'default')
        else if (event.shiftKey) openNextShell(row)
        else void runRow(row, 'last')
        return
      }
      // Digits are shortcuts only when the list is not filtered, so typing a
      // digit into the search box never launches something.
      if (!query && /^[1-9]$/.test(event.key)) {
        event.preventDefault()
        const row = flatRows[Number(event.key) - 1]
        if (row) void runRow(row, 'last')
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [flatRows, openNextShell, query, runRow, selected])

  const showEmptyHint = config.entries.length === 0

  return (
    <div className="launcher">
      <div className="launcher-inner" ref={innerRef}>
        <div className="search-shell">
          <span className="prompt">&gt;_</span>
        <input
          ref={inputRef}
          className="search"
          autoFocus
          spellCheck={false}
          placeholder={showEmptyHint ? '输入一个目录路径，回车直接打开' : '搜索目录，或输入路径…'}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span
          className="grip"
          title={placement === 'cursor' ? '拖动可固定位置，双击切到跟随光标' : '双击恢复跟随光标'}
          onDoubleClick={restoreCursorPlacement}
        />
        </div>

        {placement === 'fixed' && (
          <div className="notice info">
            已固定在当前位置。
            <button className="link" onClick={restoreCursorPlacement}>
              恢复跟随光标
            </button>
          </div>
        )}

        {error && <div className="notice error">{error}</div>}

        <div className="list" ref={listRef}>
          {flatRows.length === 0 ? (
            <div className="no-result">
              {showEmptyHint ? (
                <>
                  <p>还没有保存任何目录。</p>
                  <p className="dim">上面直接输入路径就能开一个终端，或者</p>
                  <button className="primary" onClick={() => api.beginAddEntry()}>
                    添加第一个目录
                  </button>
                </>
              ) : (
                <p>没有匹配「{query}」的目录</p>
              )}
            </div>
          ) : (
            sections.map((section, sectionIndex) => (
              <div className="section" key={`${section.name}-${sectionIndex}`}>
                {section.name && <div className="section-title">{section.name}</div>}
                {section.rows.map((row) => {
                  const flatIndex = flatRows.indexOf(row)
                  const isPath = row.key === '__path__'
                  return (
                    <EntryRow
                      key={row.key}
                      row={row}
                      index={flatIndex}
                      selected={flatIndex === selected}
                      onHover={() => setSelected(flatIndex)}
                      onOpen={() => void runRow(row, 'last')}
                      variant={isPath ? 'path' : undefined}
                    />
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>

      <Footer hasPlacement={placement === 'fixed'} />
      {pathSelected && <span className="sr-only">当前选中的是打开路径操作</span>}
    </div>
  )
}

function Footer({ hasPlacement }: { hasPlacement: boolean }) {
  return (
    <div className="footer">
      <span>
        <kbd>Enter</kbd> 打开
      </span>
      <span>
        <kbd>Shift</kbd>+<kbd>Enter</kbd> 换shell
      </span>
      <span>
        <kbd>Alt</kbd>+<kbd>Enter</kbd> 打开文件夹
      </span>
      <span>
        <kbd>Ctrl</kbd>+<kbd>N</kbd> 添加
      </span>
      <span className="grow" />
      {hasPlacement && <span className="dim">可拖动</span>}
      <span>
        <kbd>Esc</kbd> 关闭
      </span>
    </div>
  )
}

