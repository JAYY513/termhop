import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Config,
  Entry,
  HistoryItem,
  OpenTarget,
  PlacementMode,
  ShellAvailability,
  ShellId
} from '@shared/types'
import { PREFERRED_SHELL_ORDER } from '@shared/types'
import { SHELL_META, api, entryTitle, formatAgo, preferredShellId, shortPath } from '../api'
import { matchEntry } from '../fuzzy'
import EntryRow, { type LauncherRow, type RowState } from './EntryRow'

interface Props {
  config: Config
  onConfig: (config: Config) => void
}

interface Section {
  name: string
  rows: LauncherRow[]
}

/**
 * One row per installed shell, for the shell picker.
 *
 * `entryId` and `path` are copied from the row being acted on, so confirming
 * one of these launches the directory the user actually had selected, and
 * `subtitle` keeps that directory's name on screen while the list of shells
 * replaces the list of directories.
 */
function shellRow(target: LauncherRow, shell: ShellId): LauncherRow {
  return {
    key: `__shell__${shell}`,
    entryId: target.entryId,
    title: SHELL_META[shell]?.label ?? shell,
    path: target.path,
    subtitle: target.title,
    badge: SHELL_META[shell]?.badge ?? shell,
    meta: 'Enter',
    titleIndices: [],
    pathIndices: [],
    shell
  }
}

/**
 * How long the "opened" confirmation stays up before the launcher closes.
 *
 * Long enough to actually read, short enough that the panel does not sit on
 * top of the terminal it just opened.
 */
const CONFIRM_MS = 750

/**
 * What the launcher is doing right now. Every state below `idle` is feedback:
 * a click that starts something, one that worked and one that did not all have
 * to look the same before, and "did it work?" was unanswerable.
 *
 * `saving` and `saved` are the same argument applied to a config write instead
 * of a process spawn: the row that saves a directory has to say so too, or a
 * silent success reads as a dropped keystroke.
 */
type Phase =
  | { kind: 'idle' }
  | { kind: 'launching'; key: string; title: string }
  | { kind: 'done'; key: string; title: string; shell: ShellId | null; deduped: boolean }
  | { kind: 'failed'; key: string; title: string; message: string }
  | { kind: 'saving'; key: string; title: string }
  | { kind: 'saved'; key: string; title: string }

/** C:\work\thing, D:\a\b, ~/dev/app, ./sub — anything path shaped. */
const PATH_LIKE = /^(?:[a-zA-Z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/])/

/**
 * How far one PageDown should travel: what actually fits on screen, minus one
 * so the row landed on is still visible. Read from the DOM at press time —
 * the window is sized to its content, so the list is anywhere from two rows
 * to eight and no fixed number is right.
 */
function pageStep(list: HTMLElement | null): number {
  const row = list?.querySelector<HTMLElement>('.row')
  const rowHeight = row?.offsetHeight ?? 0
  const visible = list?.clientHeight ?? 0
  if (!rowHeight || !visible) return 1
  return Math.max(1, Math.floor(visible / rowHeight) - 1)
}

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

/**
 * Renders the same path as the row that keeps it.
 *
 * The badge is the shell this entry will open with, not decoration: the main
 * process defaults a new entry to the same shell the path row would have used,
 * so what the badge promises and what Enter later does cannot disagree.
 */
function saveRow(query: string, shell: ShellId): LauncherRow {
  return {
    key: '__save__',
    entryId: '',
    title: query,
    path: query,
    subtitle: '存为常用目录',
    badge: SHELL_META[shell]?.badge ?? shell,
    meta: 'Enter',
    titleIndices: [],
    pathIndices: []
  }
}

/**
 * Whether the typed path is already one of the saved entries.
 *
 * Best effort and case-insensitive, which covers the common case of pasting or
 * retyping a path that was copied out of the list. `~/dev` and relative forms
 * still slip through, and the main process is what actually refuses them — this
 * only avoids offering an action that is certain to fail.
 */
function alreadySaved(entries: Entry[], query: string): boolean {
  const wanted = query.trim().replace(/[\\/]+$/, '').toLowerCase()
  if (!wanted) return false
  return entries.some((entry) => entry.path.replace(/[\\/]+$/, '').toLowerCase() === wanted)
}

export default function Launcher({ config, onConfig }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [placement, setPlacement] = useState<PlacementMode>('cursor')
  const [shells, setShells] = useState<ShellAvailability | null>(null)
  /**
   * The row a shell is being chosen for, or null when the picker is closed.
   *
   * Held as a snapshot rather than an index: the list behind it is about to be
   * replaced, so the row cannot be re-derived from it afterwards. Returning
   * from the picker needs the original position, which is why the index is
   * kept separately.
   */
  const [shellPick, setShellPick] = useState<LauncherRow | null>(null)
  const [pickReturn, setPickReturn] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)

  /**
   * The in-flight lock is a ref, not state, on purpose.
   *
   * A held Enter key fires keydown about every 30ms, which is far faster than
   * React commits a re-render. Any guard read out of state would still be
   * 'idle' when the next repeat arrived, and every repeat would start its own
   * terminal. A ref is updated synchronously, so the second keydown is already
   * too late to get through.
   */
  const busyRef = useRef(false)
  const settleTimer = useRef<number | null>(null)

  const error = phase.kind === 'failed' ? phase.message : null
  const launching = phase.kind === 'launching'
  // While a launch is under way the list is frozen: moving the selection or
  // the rows under the user mid-launch reads as the list reacting to nothing.
  // A save is included — it rewrites the very list being scrolled, and letting
  // the rows shift under a key repeat is how a double save becomes an error.
  const locked =
    phase.kind === 'launching' || phase.kind === 'done' || phase.kind === 'saving'

  useEffect(() => {
    api
      .getPlacement()
      .then((value) => setPlacement(value.mode))
      .catch(() => undefined)
  }, [])

  // Cached on the main-process side, so this is a lookup rather than a probe.
  // It is only here to label the save row; the choice itself is made in main.
  useEffect(() => {
    api
      .checkShells()
      .then(setShells)
      .catch(() => undefined)
  }, [])

  const preferredShell = useMemo(() => preferredShellId(shells), [shells])

  /**
   * Only the shells that are actually installed. Cycling into a missing one
   * used to fail the whole launch with "was not found on this system" — a key
   * that exists to change which shell you get should never be the reason
   * nothing opens.
   */
  const cycleShells = useMemo(
    () => (shells ? PREFERRED_SHELL_ORDER.filter((id) => shells[id]) : []),
    [shells]
  )

  const lastUsed = useMemo(() => {
    const map = new Map<string, HistoryItem>()
    for (const item of config.history) {
      if (!map.has(item.entryId)) map.set(item.entryId, item)
    }
    return map
  }, [config.history])

  const sections = useMemo<Section[]>(() => {
    // The picker replaces the list rather than opening a panel beside it: the
    // panel is 680px wide with a single input, and a second surface would have
    // nowhere to sit without moving the list it is choosing for.
    if (shellPick) {
      return [
        {
          name: `用哪个 shell 打开 ${shellPick.title}`,
          rows: cycleShells.map((shell) => shellRow(shellPick, shell))
        }
      ]
    }

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
      if (PATH_LIKE.test(trimmed)) {
        rows.push(pathRow(trimmed))
        // Saving is offered only when it would work and has not been done.
        // Offering it for a path that is already in the list would be a row
        // whose only possible outcome is the duplicate error.
        if (preferredShell && !alreadySaved(config.entries, trimmed)) {
          rows.push(saveRow(trimmed, preferredShell))
        }
      }
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
  }, [config, cycleShells, lastUsed, preferredShell, query, shellPick])

  const flatRows = useMemo(() => sections.flatMap((section) => section.rows), [sections])
  const pathSelected = flatRows[selected]?.key === '__path__'
  // The save row is the only one that can appear or disappear as the user
  // types, so "can I save right now" is a question about the list, not a flag.
  const saveRowIndex = flatRows.findIndex((row) => row.key === '__save__')
  const canSave = saveRowIndex >= 0

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
  }, [sections, error, phase.kind, placement])

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
      // A picker left open across a hide would greet the next open with a list
      // of shells for a row the user is no longer looking at.
      setShellPick(null)
      setPickReturn(0)
      // Whatever the last attempt did, the next one starts from a clean slate.
      // Leaving a stale 'failed' row behind would blame the row the user is
      // about to pick for the previous failure.
      if (settleTimer.current !== null) {
        window.clearTimeout(settleTimer.current)
        settleTimer.current = null
      }
      busyRef.current = false
      setPhase({ kind: 'idle' })
      inputRef.current?.focus()
    })
    const offConfig = api.on('config:changed', (next) => onConfig(next))
    return () => {
      offShown()
      offConfig()
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current)
    }
  }, [onConfig])

  /**
   * Keeps the typed path as a saved entry, without leaving the launcher.
   *
   * The query is replaced with the new entry's name on success. That is the
   * whole feedback design: the synthetic rows turn back into a real one, the
   * input stops being a path nobody has saved, and the next Enter opens the
   * terminal the user was after when they first typed it. Saving and launching
   * in one keystroke was rejected — two effects from one press makes "did it
   * open?" unanswerable, which is the exact ambiguity the Phase union exists
   * to prevent.
   */
  const savePath = useCallback(
    async (raw: string) => {
      if (busyRef.current) return
      busyRef.current = true
      setPhase({ kind: 'saving', key: '__save__', title: raw })

      const result = await api.addEntry({
        path: raw,
        defaultShell: preferredShell ?? undefined
      })

      if (!result.ok) {
        // Stays open for the same reason a failed launch does: there is one
        // keystroke away from correcting the path, so this must be retryable.
        setPhase({
          kind: 'failed',
          key: '__save__',
          title: raw,
          message: result.error ?? '保存失败'
        })
        busyRef.current = false
        api.launcherSettled()
        return
      }

      const entry = result.config.entries.find((item) => item.id === result.entryId)
      const title = entry ? entryTitle(entry) : raw
      setQuery(title)
      setSelected(0)
      setPhase({ kind: 'saved', key: '__save__', title })
      // Not held: the next Enter is meant to open what was just saved, and the
      // list has already changed underneath the user by then.
      busyRef.current = false
    },
    [preferredShell]
  )

  /**
   * The one place a launch starts, holds the in-flight lock, and reports how it
   * went — whether the row is a saved entry, a typed path, or a shell picked out
   * of the picker. Every one of those has the same three states, and a variant
   * that reports them differently is how a click stopped being able to answer
   * "did it work?".
   */
  const launchRow = useCallback(async (row: LauncherRow, target: OpenTarget) => {
    if (busyRef.current) return
    busyRef.current = true
    setPhase({ kind: 'launching', key: row.key, title: row.title })

    // A typed path has no entry for a target to hang on, so the two actions it
    // can serve are dispatched by hand. `reveal` used to fall through to the
    // terminal branch, which made the advertised Alt+Enter open a terminal on
    // the one row where asking for the folder is the obvious move.
    const result = row.entryId
      ? await api.openEntry(row.entryId, target)
      : target === 'reveal'
        ? await api.revealPath(row.path)
        : await api.openPath(row.path)

    if (!result.ok) {
      // The launcher stays open. A failed launch is something the user has to
      // read and react to, and the row is one Enter away from a retry, so
      // releasing the lock here is what makes retrying possible at all.
      setPhase({
        kind: 'failed',
        key: row.key,
        title: row.title,
        message: result.error ?? '启动失败'
      })
      busyRef.current = false
      api.launcherSettled()
      return
    }

    setPhase({
      kind: 'done',
      key: row.key,
      title: row.title,
      shell: result.shell ?? null,
      deduped: result.deduped ?? false
    })

    // The main process is holding the window open against the focus theft of
    // the terminal that just opened, which is what let this confirmation be
    // read at all. Now that it has been, the window may go.
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null
      api.hideLauncher()
      api.launcherSettled()
    }, CONFIRM_MS)
    // busyRef stays true until the next 'launcher:shown': a second Enter
    // during the confirmation must not start a second terminal.
  }, [])

  const runRow = useCallback(
    async (row: LauncherRow, target: OpenTarget) => {
      // The save row's own action is saving, so it only stands aside for
      // Alt+Enter, which means the same thing on every row.
      if (row.key === '__save__' && target !== 'reveal') {
        await savePath(row.path)
        return
      }
      await launchRow(row, target)
    },
    [launchRow, savePath]
  )

  /**
   * Opens the shell picker for a row.
   *
   * This replaced a cycle through a fixed list. The preview I put in the footer
   * first made the next shell visible, which removed the surprise, but not the
   * two things that actually hurt: every press opened a real terminal and moved
   * the position, so overshooting had no undo — only another window — and a
   * cycle is one blind bit, which cannot express "wt, not cmd".
   */
  const beginShellPick = useCallback(
    (row: LauncherRow) => {
      // Nothing to choose between, so there is no reason to make the user come
      // back out of a picker: one shell installed, or a typed path that already
      // opens with the one the panel would have used.
      if (!row.entryId || cycleShells.length < 2) {
        void runRow(row, 'last')
        return
      }
      const entry = config.entries.find((item) => item.id === row.entryId)
      const current = entry?.lastShell ?? entry?.defaultShell ?? null
      const index = current ? cycleShells.indexOf(current) : -1
      setPickReturn(selected)
      setShellPick(row)
      // Lands on what a plain Enter would have used, so confirming straight
      // away changes nothing and moving off it is a deliberate act.
      setSelected(index < 0 ? 0 : index)
    },
    [config.entries, cycleShells, runRow, selected]
  )

  /** Takes the highlighted shell and closes the picker, or backs out of it. */
  const confirmShell = useCallback(
    (row: LauncherRow | undefined) => {
      if (!row?.shell) return
      setShellPick(null)
      // Back to the directory row. A failed launch keeps the launcher open, and
      // the retry has to start from the row the user was trying to open, not
      // from whichever row happens to sit at the shell's index.
      setSelected(pickReturn)
      void runRow(row, row.shell)
    },
    [pickReturn, runRow]
  )

  const cancelShellPick = useCallback(() => {
    setShellPick(null)
    setSelected(pickReturn)
  }, [pickReturn])

  const restoreCursorPlacement = () => {
    if (placement === 'cursor') return
    void api.setPlacementMode('cursor').then(() => setPlacement('cursor'))
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        // Two levels: the first Escape backs out of the picker and leaves the
        // launcher alone, because a mistimed Escape should not throw away the
        // search the user is standing in.
        if (shellPick) cancelShellPick()
        else api.hideLauncher()
        return
      }
      // Anything that could start a second launch, or move the list out from
      // under a launch already in flight, is swallowed. Escape deliberately
      // stays live: bailing out of a slow launch is always allowed.
      //
      // Ctrl+N belongs to the launch group, not the navigation group: it is
      // the add shortcut the footer advertises, and it opens a form or saves
      // a path, both of which are things a launch in flight must not race.
      const isLaunchKey =
        event.key === 'Enter' ||
        /^[1-9]$/.test(event.key) ||
        (event.ctrlKey && event.key === 'n')
      const isNavKey =
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'PageDown' ||
        event.key === 'PageUp' ||
        (event.key === 'Home' && !query) ||
        (event.key === 'End' && !query) ||
        (event.ctrlKey && event.key === 'p')
      // `busyRef` covers the gap before this handler's closure is rebuilt, and
      // `locked` is the same condition as the UI sees it. Either alone would do;
      // together there is no frame in which a repeat gets through.
      if ((busyRef.current || locked) && (isLaunchKey || isNavKey)) {
        event.preventDefault()
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelected((prev) => (flatRows.length ? (prev + 1) % flatRows.length : 0))
        return
      }
      // Ctrl+P is "previous", so it moves up — the way P reads everywhere
      // else. It used to move down, paired with a Ctrl+N that moved up, and
      // that pair is why Ctrl+N could not also be the add shortcut: the first
      // branch to claim a key wins, and the navigation branch was first.
      if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
        event.preventDefault()
        setSelected((prev) => (flatRows.length ? (prev - 1 + flatRows.length) % flatRows.length : 0))
        return
      }
      // One screen at a time, measured rather than hardcoded. The window is
      // sized to its content and capped, so the list is anywhere from two rows
      // to eight; a fixed step would overshoot a short list and crawl through a
      // long one. Minus one keeps the row you land on still on screen.
      if (event.key === 'PageDown' || event.key === 'PageUp') {
        event.preventDefault()
        const step = pageStep(listRef.current)
        const last = Math.max(0, flatRows.length - 1)
        setSelected((prev) =>
          event.key === 'PageDown' ? Math.min(last, prev + step) : Math.max(0, prev - step)
        )
        return
      }
      // Home and End move the caret in a text field, so they only drive the
      // list while the search box is empty — the same rule the digit shortcuts
      // already follow.
      if (event.key === 'Home' && !query) {
        event.preventDefault()
        setSelected(0)
        return
      }
      if (event.key === 'End' && !query) {
        event.preventDefault()
        setSelected(Math.max(0, flatRows.length - 1))
        return
      }
      if (event.key === ',' && event.ctrlKey) {
        event.preventDefault()
        api.openSettings()
        return
      }
      if (event.key === 'n' && event.ctrlKey) {
        event.preventDefault()
        // "New" means new, not "go open a different window and fill in a form".
        // With a path already typed there is something to save right here; with
        // an empty box there is nothing, and the full form is still the answer.
        //
        // This branch was unreachable from the very first commit: the
        // navigation branch above it also matched Ctrl+N and returned first,
        // so the footer advertised an "add" shortcut that moved the selection
        // instead. Keep this branch below the navigation one only if the
        // navigation one no longer claims Ctrl+N.
        if (canSave) void savePath(flatRows[saveRowIndex].path)
        else api.openSettings()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const row = flatRows[selected]
        if (!row) return
        // A row in the shell picker carries the choice it stands for, so Enter
        // takes that choice rather than the modifier logic below.
        if (row.shell) {
          confirmShell(row)
          return
        }
        if (event.altKey) void runRow(row, 'reveal')
        else if (event.ctrlKey) void runRow(row, 'default')
        else if (event.shiftKey) beginShellPick(row)
        else void runRow(row, 'last')
        return
      }
      // Digits are row shortcuts only when the list is not filtered, so typing a
      // digit into the search box never launches something. The shell picker is
      // the exception: the list there is frozen, the input is read-only, and a
      // digit is the fastest way to name one of at most four shells.
      if ((shellPick || !query) && /^[1-9]$/.test(event.key)) {
        event.preventDefault()
        const row = flatRows[Number(event.key) - 1]
        if (row?.shell) confirmShell(row)
        else if (row) void runRow(row, 'last')
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    beginShellPick,
    canSave,
    cancelShellPick,
    confirmShell,
    flatRows,
    locked,
    query,
    runRow,
    savePath,
    saveRowIndex,
    selected,
    shellPick
  ])

  const showEmptyHint = config.entries.length === 0

  // Kept short on purpose: the entry name lives in the row, and repeating it
  // here would push the drag grip out of the panel.
  const statusText =
    phase.kind === 'launching'
      ? '启动中…'
      : phase.kind === 'saving'
        ? '保存中…'
        : phase.kind === 'saved'
          ? '已保存 · 回车打开'
          : phase.kind === 'done'
            ? `${phase.deduped ? '已在启动' : '已打开'}${phase.shell ? ` · ${phase.shell}` : ''}`
            : ''

  return (
    <div className="launcher">
      <div className="launcher-inner" ref={innerRef}>
        <div className={`search-shell${locked ? ' busy' : ''}`}>
          <span className="prompt">&gt;_</span>
        <input
          ref={inputRef}
          className="search"
          autoFocus
          spellCheck={false}
          placeholder={showEmptyHint ? '输入一个目录路径，回车直接打开' : '搜索目录，或输入路径…'}
          // While the shell picker is open the list is frozen, so anything typed
          // here would filter nothing. Read-only rather than hidden: the field
          // keeps the focus, and the row it names is what the picker is about.
          readOnly={Boolean(shellPick)}
          value={shellPick ? shellPick.title : query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {/* Sits on top of the input rather than beside it: the search field is
            the one thing in this window that must not shift under the user. */}
        <span
          className={`search-status ${phase.kind}`}
          role="status"
          aria-live="polite"
          // A screen reader gets the entry name, which is the part that says
          // *what* just happened. The visible text stays short on purpose.
          aria-label={phase.kind === 'idle' ? undefined : `${phase.title}：${statusText}`}
        >
          {phase.kind === 'launching' && (
            <>
              <span className="spin" />
              {statusText}
            </>
          )}
          {phase.kind === 'saving' && (
            <>
              <span className="spin" />
              {statusText}
            </>
          )}
          {(phase.kind === 'done' || phase.kind === 'saved') && (
            <>
              <span className="tick">✓</span>
              {statusText}
            </>
          )}
        </span>
        <span
          className="grip"
          // The only in-panel way back to cursor-following. It used to also have
          // a permanent banner saying the panel was fixed, which spent a whole
          // row on every single open, to tell the user about a drag they just
          // performed and could undo at any time.
          title={placement === 'cursor' ? '拖动可固定位置，双击切到跟随光标' : '双击恢复跟随光标'}
          onDoubleClick={restoreCursorPlacement}
        />
        </div>

        {error && (
          <div className="notice error" role="alert">
            <span>{error}</span>
            <span className="notice-hint">Enter 重试</span>
          </div>
        )}

        <div className={`list${launching ? ' busy' : ''}`} ref={listRef}>
          {flatRows.length === 0 ? (
            <div className="no-result">
              {showEmptyHint ? (
                <>
                  <p>还没有保存任何目录。</p>
                  <p className="dim">上面直接输入路径就能开一个终端，↓ 一下还能存下来</p>
                  <button className="primary" onClick={() => api.beginAddEntry()}>
                    用完整表单添加
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
                  const variant = row.key === '__path__' ? 'path' : row.key === '__save__' ? 'save' : undefined
                  // A launch can be started from a digit shortcut, where the
                  // row is not the selected one. Marking the row that was
                  // actually asked for is what makes the feedback land.
                  const rowPhase = phase.kind !== 'idle' && phase.key === row.key ? phase : null
                  // A save reports through the same two states a launch uses —
                  // busy, then done — because the row that reports them is
                  // shared. The wording is what tells the two apart.
                  const state: RowState =
                    rowPhase === null
                      ? 'idle'
                      : rowPhase.kind === 'launching' || rowPhase.kind === 'saving'
                        ? 'launching'
                        : rowPhase.kind === 'done' || rowPhase.kind === 'saved'
                          ? 'done'
                          : 'failed'
                  // One wording per state, so the row and the header can never
                  // tell the user two different things about the same launch.
                  const stateLabel =
                    rowPhase === null
                      ? ''
                      : rowPhase.kind === 'saving'
                        ? '保存中'
                        : rowPhase.kind === 'saved'
                          ? '✓ 已保存'
                          : rowPhase.kind === 'launching'
                            ? '启动中'
                            : rowPhase.kind === 'done'
                              ? rowPhase.deduped
                                ? '✓ 已在启动'
                                : '✓ 已打开'
                              : '✕ 失败'
                  return (
                    <EntryRow
                      key={row.key}
                      row={row}
                      index={flatIndex}
                      selected={flatIndex === selected}
                      state={state}
                      stateLabel={stateLabel}
                      onHover={() => {
                        if (!locked) setSelected(flatIndex)
                      }}
                      // A shell row stands for one choice, so clicking it takes
                      // that choice rather than the row's default action.
                      onOpen={() => {
                        if (row.shell) confirmShell(row)
                        else void runRow(row, 'last')
                      }}
                      variant={variant}
                    />
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>

      <Footer
        hasPlacement={placement === 'fixed'}
        canSave={canSave}
        shellCount={cycleShells.length}
        picking={Boolean(shellPick)}
      />
      {pathSelected && !shellPick && <span className="sr-only">当前选中的是打开路径操作</span>}
    </div>
  )
}

function Footer({
  hasPlacement,
  canSave,
  shellCount,
  picking
}: {
  hasPlacement: boolean
  canSave: boolean
  shellCount: number
  picking: boolean
}) {
  return (
    <div className="footer">
      {/* The picker owns the footer while it is open. Leaving the normal hints
          up would be describing keys that now do something else: Enter takes
          the highlighted shell, and Esc backs out instead of closing. */}
      {picking ? (
        <>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>1</kbd>-<kbd>{shellCount}</kbd> 直选
          </span>
          <span>
            <kbd>Enter</kbd> 打开
          </span>
          <span className="grow" />
          <span>
            <kbd>Esc</kbd> 返回
          </span>
        </>
      ) : (
        <>
          <span>
            <kbd>Enter</kbd> 打开
          </span>
          {/* Dimmed rather than removed when there is nothing to choose between
              (a typed path, or a machine with one shell installed), because
              dropping the item would shift everything after it sideways on
              every arrow key. */}
          <span className={shellCount < 2 ? 'dim' : undefined}>
            <kbd>Shift</kbd>+<kbd>Enter</kbd> 选shell
          </span>
          <span>
            <kbd>Alt</kbd>+<kbd>Enter</kbd> 打开文件夹
          </span>
          {/* Only one of these is ever true. The save row exists exactly when a
              path is typed and not yet saved, so showing "添加" next to it would
              describe a shortcut that no longer does what it says. */}
          {canSave ? (
            <span>
              <kbd>↓</kbd>+<kbd>Enter</kbd> 存下来
            </span>
          ) : (
            <span>
              <kbd>Ctrl</kbd>+<kbd>N</kbd> 添加
            </span>
          )}
          <span className="grow" />
          {hasPlacement && <span className="dim">可拖动</span>}
          <span>
            <kbd>Esc</kbd> 关闭
          </span>
        </>
      )}
    </div>
  )
}

