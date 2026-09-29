import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AutoLaunchState,
  CliInstallResult,
  Config,
  Entry,
  PlacementMode,
  ShellAvailability,
  ShellId,
  TrashItem
} from '@shared/types'
import { SHELL_OPTIONS, api, entryTitle, formatAgo } from '../api'

interface Props {
  initial: Config
}

interface EntryDraft {
  id: string | null
  path: string
  title: string
  groupId: string | null
  defaultShell: ShellId
  initCmd: string
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function emptyDraft(): EntryDraft {
  return { id: null, path: '', title: '', groupId: null, defaultShell: 'powershell', initCmd: '' }
}

function trashLabel(item: TrashItem): string {
  if (item.kind === 'group') return item.group?.name ?? '（已损坏的分组）'
  return item.entry ? entryTitle(item.entry) : '（已损坏的目录）'
}

function trashHint(item: TrashItem): string {
  if (item.kind === 'group') {
    const count = item.memberEntryIds?.length ?? 0
    return count ? `${count} 个目录会一起恢复` : '空分组'
  }
  return item.entry?.path ?? ''
}

const MODIFIER_LABELS: Record<string, string> = {
  Control: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
  Super: 'Win'
}

const KEY_LABELS: Record<string, string> = {
  Space: 'Space',
  Return: 'Enter',
  Esc: 'Esc',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Home: 'Home',
  End: 'End',
  Insert: 'Insert'
}

/** Turns a KeyboardEvent into an Electron accelerator, or null if it cannot be one. */
function eventToAccelerator(event: KeyboardEvent): string | null {
  if (event.key === 'Escape') return null
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Super')
  // A bare key would swallow normal typing, so require at least one modifier.
  if (!parts.length) return null

  let key: string | null = null
  const { code } = event
  if (code.startsWith('Key')) key = code.slice(3)
  else if (code.startsWith('Digit')) key = code.slice(5)
  else if (/^F\d{1,2}$/.test(event.key)) key = event.key
  else if (code.startsWith('Numpad') && code.length > 6) key = code.slice(6)
  else key = KEY_LABELS[event.key] && code === event.key ? event.key : (KEY_LABELS[code] ?? (KEY_LABELS[event.key] ?? null))
  if (!key || /^(Control|Alt|Shift|Meta)(Left|Right)?$/.test(code)) return null

  parts.push(key)
  return parts.join('+')
}

function prettyAccelerator(accelerator: string): string {
  if (!accelerator) return '未设置'
  return accelerator
    .split('+')
    .map((part) => MODIFIER_LABELS[part] ?? KEY_LABELS[part] ?? part)
    .join(' + ')
}

export default function Settings({ initial }: Props) {
  const [config, setConfig] = useState<Config>(initial)
  const [shells, setShells] = useState<ShellAvailability | null>(null)
  const [hotkeyError, setHotkeyError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [draft, setDraft] = useState<EntryDraft | null>(null)
  const [newGroup, setNewGroup] = useState('')
  const [version, setVersion] = useState('')
  const [configDir, setConfigDir] = useState('')
  const [cli, setCli] = useState<CliInstallResult | null>(null)
  const [cliError, setCliError] = useState<string | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [autoLaunch, setAutoLaunch] = useState<AutoLaunchState>({ enabled: false, supported: true })
  const [placement, setPlacement] = useState<PlacementMode>('cursor')
  const [notices, setNotices] = useState<string[]>([])
  // Set while one of our own saves is in flight, so the resulting broadcast
  // does not replace state we have already applied.
  const savingRef = useRef(false)

  useEffect(() => {
    api.getVersion().then(setVersion).catch(() => undefined)
    api.openConfigDir().then(setConfigDir).catch(() => undefined)
    api.checkShells().then(setShells).catch(() => undefined)
    // Windows is the source of truth for autostart: the user can also flip it
    // in Task Manager, and a stale config would show the wrong checkbox.
    api
      .getAutoLaunchState()
      .then((state) => {
        setAutoLaunch(state)
        if (state.supported && state.enabled !== config.settings.launchOnStartup) {
          setConfig((prev) => ({
            ...prev,
            settings: { ...prev.settings, launchOnStartup: state.enabled }
          }))
        }
      })
      .catch(() => undefined)
    api
      .getNotices()
      .then((items) => {
        if (items.length) setNotices(items)
      })
      .catch(() => undefined)
    api
      .getPlacement()
      .then((value) => setPlacement(value.mode))
      .catch(() => undefined)
    // A pending "add a directory" request may have been made before this
    // window finished loading.
    api
      .consumeBeginAdd()
      .then((pending) => {
        if (pending) {
          setDraftError(null)
          setDraft(emptyDraft())
        }
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    return api.on('config:changed', (next) => {
      if (savingRef.current) return
      // A change made elsewhere (e.g. `termhop add .` in a terminal) must not
      // wipe out what the user is halfway through typing.
      const active = document.activeElement
      if (
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' || active.tagName === 'SELECT')
      ) {
        return
      }
      setConfig(next)
    })
  }, [])

  const persist = useCallback(async (next: Config) => {
    savingRef.current = true
    try {
      const saved = await api.saveConfig(next)
      setConfig(saved)
      return saved
    } finally {
      savingRef.current = false
    }
  }, [])

  const setSetting = useCallback(
    <K extends keyof Config['settings']>(key: K, value: Config['settings'][K]) => {
      void persist({ ...config, settings: { ...config.settings, [key]: value } })
    },
    [config, persist]
  )

  /* ------------------------------------------------------------- hotkey */

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        return
      }
      const accelerator = eventToAccelerator(event)
      if (!accelerator) return
      void (async () => {
        const result = await api.setHotkey(accelerator)
        setRecording(false)
        if (result.ok) {
          setHotkeyError(null)
          setConfig((prev) => ({ ...prev, hotkey: accelerator }))
        } else {
          setHotkeyError(result.error ?? '注册失败')
        }
      })()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording])

  const clearHotkey = () => {
    void (async () => {
      const result = await api.setHotkey('')
      if (result.ok) {
        setHotkeyError(null)
        setConfig((prev) => ({ ...prev, hotkey: '' }))
      } else {
        setHotkeyError(result.error ?? '清除失败')
      }
    })()
  }

  /* ------------------------------------------------------------- groups */

  const addGroup = () => {
    const name = newGroup.trim()
    if (!name) return
    const group = { id: uid('group'), name, order: config.groups.length }
    setNewGroup('')
    void persist({ ...config, groups: [...config.groups, group] })
  }

  const renameGroup = (id: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    void persist({
      ...config,
      groups: config.groups.map((group) => (group.id === id ? { ...group, name: trimmed } : group))
    })
  }

  const removeGroup = (id: string) => {
    void api.trashGroup(id).then(setConfig)
  }

  const moveGroup = (index: number, delta: number) => {
    const groups = [...config.groups]
    const target = index + delta
    if (target < 0 || target >= groups.length) return
    const [item] = groups.splice(index, 1)
    groups.splice(target, 0, item)
    void persist({ ...config, groups: groups.map((group, i) => ({ ...group, order: i })) })
  }

  /* ------------------------------------------------------------ entries */

  const groupedEntries = useMemo(() => config.entries, [config.entries])

  const saveDraft = async () => {
    if (!draft) return
    const path = draft.path.trim()
    if (!path) {
      setDraftError('请填写目录路径')
      return
    }
    setDraftError(null)

    if (draft.id) {
      const entries = config.entries.map((entry) =>
        entry.id === draft.id
          ? {
              ...entry,
              path,
              title: draft.title.trim(),
              groupId: draft.groupId,
              defaultShell: draft.defaultShell,
              initCmd: draft.initCmd.trim() || null
            }
          : entry
      )
      await persist({ ...config, entries })
      setDraft(null)
      return
    }

    // New entries go through the main process so the form and the CLI share
    // one implementation of "add an entry".
    const result = await api.addEntry({
      path,
      title: draft.title,
      groupId: draft.groupId,
      defaultShell: draft.defaultShell,
      initCmd: draft.initCmd.trim() || null
    })
    if (!result.ok) {
      setDraftError(result.error ?? '保存失败')
      return
    }
    setConfig(result.config)
    setDraft(null)
  }

  const installCli = async () => {
    setCliError(null)
    try {
      setCli(await api.installCli())
    } catch (error) {
      setCliError((error as Error).message)
    }
  }

  const addCliToPath = async () => {
    setCliError(null)
    const result = await api.addCliToPath()
    if (result.ok) setCli((prev) => (prev ? { ...prev, onPath: true } : prev))
    else setCliError(result.error ?? '加入 PATH 失败')
  }

  const removeEntry = (id: string) => {
    void api.trashEntry(id).then(setConfig)
  }

  const restoreItem = (id: string) => {
    void api.trashRestore(id).then(setConfig)
  }

  const purgeItem = (id: string) => {
    if (!window.confirm('永久删除？这一项将无法恢复。')) return
    void api.trashPurge(id).then(setConfig)
  }

  const clearTrash = () => {
    if (!window.confirm('清空回收站？里面的内容将无法恢复。')) return
    void api.trashClear().then(setConfig)
  }

  const patchEntry = (id: string, patch: Partial<Entry>) => {
    void persist({
      ...config,
      entries: config.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))
    })
  }

  const moveEntry = (id: string, delta: number) => {
    const entries = [...config.entries].sort((a, b) => a.order - b.order)
    const index = entries.findIndex((entry) => entry.id === id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= entries.length) return
    const [item] = entries.splice(index, 1)
    entries.splice(target, 0, item)
    void persist({
      ...config,
      entries: entries.map((entry, i) => ({ ...entry, order: i }))
    })
  }

  const pickFolder = async () => {
    const chosen = await api.pickDirectory()
    if (!chosen) return
    setDraft((prev) =>
      prev
        ? { ...prev, path: chosen, title: prev.title || chosen.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '' }
        : prev
    )
  }

  return (
    <div className="settings">
      <header>
        <h1>TermHop 设置</h1>
        <span className="version">v{version}</span>
      </header>

      {notices.length > 0 && (
        <section className="banner">
          {notices.map((text, i) => (
            <p key={i}>{text}</p>
          ))}
        </section>
      )}

      <section>
        <h2>通用</h2>
        <div className="field">
          <label>全局快捷键</label>
          <div className="hotkey-row">
            <button
              className={`hotkey${recording ? ' recording' : ''}`}
              onClick={() => {
                setHotkeyError(null)
                setRecording((prev) => !prev)
              }}
            >
              {recording ? '按下新的组合键…' : prettyAccelerator(config.hotkey)}
            </button>
            <button className="ghost" onClick={clearHotkey}>
              清除
            </button>
          </div>
          {hotkeyError && <p className="hint error">{hotkeyError}</p>}
          <p className="hint">点击按钮后按下组合键，Esc 取消。必须包含 Ctrl / Alt / Shift 之一。</p>
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={config.settings.restoreLastShell}
            onChange={(event) => setSetting('restoreLastShell', event.target.checked)}
          />
          打开时复用上次使用的 shell
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={config.settings.closeOnBlur}
            onChange={(event) => setSetting('closeOnBlur', event.target.checked)}
          />
          失去焦点时自动隐藏
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={config.settings.launchOnStartup}
            onChange={(event) => {
              const next = event.target.checked
              setAutoLaunch((prev) => ({ ...prev, enabled: next }))
              setSetting('launchOnStartup', next)
            }}
          />
          开机自动启动
        </label>
        {!autoLaunch.supported ? (
          <p className="hint">开发模式下不注册开机启动，正式安装后可用。</p>
        ) : (
          <p className="hint">
            开机后静默进入托盘，不会弹窗。自启指向当前这个 exe 的位置，
            移动或删除程序后需要重新开启。也可以在「任务管理器 → 启动」里改。
          </p>
        )}
        <label className="check">
          <span className="label-text">最近记录条数</span>
          <input
            className="number"
            type="number"
            min={0}
            max={20}
            value={config.settings.recentCount}
            onChange={(event) => setSetting('recentCount', Number(event.target.value))}
          />
        </label>
      </section>

      <section>
        <h2>启动面板位置</h2>
        <label className="check">
          <input
            type="radio"
            name="placement"
            checked={placement === 'cursor'}
            onChange={() => void api.setPlacementMode('cursor').then((v) => setPlacement(v.mode))}
          />
          跟随光标
        </label>
        <label className="check">
          <input
            type="radio"
            name="placement"
            checked={placement === 'center'}
            onChange={() => void api.setPlacementMode('center').then((v) => setPlacement(v.mode))}
          />
          屏幕居中
        </label>
        <label className="check">
          <input
            type="radio"
            name="placement"
            checked={placement === 'fixed'}
            onChange={() => void api.setPlacementMode('fixed').then((v) => setPlacement(v.mode))}
          />
          固定位置
        </label>
        <p className="hint">
          「跟随光标」默认在鼠标所在屏幕上、贴着光标出现，适合注意力本来就在光标附近的时候。
          想要每次位置一模一样，或者宽屏上不想让面板乱跳，就用「屏幕居中」。
          拖动面板右上角的手柄会直接切到「固定位置」；双击手柄或在面板里点提示可以还原成跟随光标。
        </p>
      </section>

      <section>
        <h2>分组</h2>
        {config.groups.length === 0 && <p className="hint">还没有分组。不加也可以用。</p>}
        <ul className="list-editor">
          {config.groups.map((group, index) => (
            <li key={group.id}>
              <input
                defaultValue={group.name}
                onBlur={(event) => renameGroup(group.id, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                }}
              />
              <span className="count">{config.entries.filter((e) => e.groupId === group.id).length}</span>
              <button className="icon" disabled={index === 0} onClick={() => moveGroup(index, -1)}>
                ↑
              </button>
              <button
                className="icon"
                disabled={index === config.groups.length - 1}
                onClick={() => moveGroup(index, 1)}
              >
                ↓
              </button>
              <button className="icon danger" onClick={() => removeGroup(group.id)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
        <div className="add-row">
          <input
            placeholder="新建分组名称"
            value={newGroup}
            onChange={(event) => setNewGroup(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addGroup()
            }}
          />
          <button className="ghost" onClick={addGroup}>
            添加
          </button>
        </div>
      </section>

      <section>
        <h2>常用目录</h2>
        <ul className="list-editor entries">
          {groupedEntries.length === 0 && <p className="hint">还没有目录，下面添加一个。</p>}
          {groupedEntries
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((entry, index) => {
              const group = config.groups.find((item) => item.id === entry.groupId)
              return (
                <li key={entry.id}>
                  <div className="entry-info">
                    <div className="entry-title">{entryTitle(entry)}</div>
                    <div className="entry-path">{entry.path}</div>
                  </div>
                  <select
                    value={entry.groupId ?? ''}
                    onChange={(event) => patchEntry(entry.id, { groupId: event.target.value || null })}
                  >
                    <option value="">未分组</option>
                    {config.groups.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={entry.defaultShell}
                    onChange={(event) =>
                      patchEntry(entry.id, { defaultShell: event.target.value as ShellId })
                    }
                  >
                    {SHELL_OPTIONS.map((shell) => (
                      <option key={shell.id} value={shell.id}>
                        {shell.badge}
                      </option>
                    ))}
                  </select>
                  {group && <span className="tag">{group.name}</span>}
                  <button className="icon" disabled={index === 0} onClick={() => moveEntry(entry.id, -1)}>
                    ↑
                  </button>
                  <button
                    className="icon"
                    disabled={index === groupedEntries.length - 1}
                    onClick={() => moveEntry(entry.id, 1)}
                  >
                    ↓
                  </button>
                  <button
                    className="icon"
                    onClick={() =>
                      setDraft({
                        id: entry.id,
                        path: entry.path,
                        title: entry.title,
                        groupId: entry.groupId,
                        defaultShell: entry.defaultShell,
                        initCmd: entry.initCmd ?? ''
                      })
                    }
                  >
                    ✎
                  </button>
                  <button className="icon danger" onClick={() => removeEntry(entry.id)}>
                    ✕
                  </button>
                </li>
              )
            })}
        </ul>
        <div className="add-row">
          <button
            className="ghost"
            onClick={() => {
              setDraftError(null)
              setDraft(emptyDraft())
            }}
          >
            + 添加目录
          </button>
          <span className="hint inline">或按 Ctrl+N 从启动器直接添加</span>
        </div>
      </section>

      <section>
        <h2>回收站</h2>
        {config.trash.length === 0 ? (
          <p className="hint">回收站是空的。删除的目录和分组会先放到这里。</p>
        ) : (
          <>
            <ul className="list-editor">
              {config.trash.map((item) => (
                <li key={item.id}>
                  <div className="entry-info">
                    <div className="entry-title">{trashLabel(item)}</div>
                    <div className="entry-path">{trashHint(item)}</div>
                  </div>
                  <span className="tag">{item.kind === 'group' ? '分组' : '目录'}</span>
                  <span className="tag">删除于 {formatAgo(item.deletedAt)}</span>
                  <button className="ghost" onClick={() => restoreItem(item.id)}>
                    恢复
                  </button>
                  <button className="icon danger" onClick={() => purgeItem(item.id)}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            <div className="add-row">
              <button className="ghost" onClick={clearTrash}>
                清空回收站
              </button>
            </div>
          </>
        )}
      </section>

      <section>
        <h2>命令行</h2>
        <p className="hint">
          装好之后，在任何终端里用 <code>termhop add .</code> 就能把当前目录加进来。
        </p>
        {cli ? (
          <div className="add-row">
            <span className="hint inline">{cli.shimPath}</span>
            {cli.onPath ? (
              <span className="tag">已在 PATH</span>
            ) : (
              <button className="ghost" onClick={() => void addCliToPath()}>
                加入 PATH
              </button>
            )}
          </div>
        ) : (
          <div className="add-row">
            <button className="ghost" onClick={() => void installCli()}>
              安装 termhop 命令
            </button>
          </div>
        )}
        {cliError && <p className="hint error">{cliError}</p>}
        <pre className="code">
          {[
            'termhop add .',
            'termhop add D:\\work\\my-project',
            'termhop open agency'
          ].join('\n')}
        </pre>
        <p className="hint">改动 PATH 只会影响新开的终端，已经开着的窗口需要重开。</p>
      </section>

      {draft && (
        <section className="draft">
          <h2>{draft.id ? '编辑目录' : '添加目录'}</h2>
          <div className="field">
            <label>路径</label>
            <div className="hotkey-row">
              <input
                autoFocus
                value={draft.path}
                placeholder="C:\\work\\my-project"
                onChange={(event) => setDraft({ ...draft, path: event.target.value })}
                onKeyDown={(event) => {
                  // Typing a path and pressing Enter is the whole flow when
                  // the caller already knows where it wants to go.
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void saveDraft()
                  }
                }}
              />
              <button className="ghost" onClick={() => void pickFolder()}>
                浏览…
              </button>
            </div>
            {draftError && <p className="hint error">{draftError}</p>}
          </div>
          <div className="field">
            <label>显示标题</label>
            <input
              value={draft.title}
              placeholder="留空则用文件夹名"
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </div>
          <div className="field">
            <label>分组</label>
            <select
              value={draft.groupId ?? ''}
              onChange={(event) => setDraft({ ...draft, groupId: event.target.value || null })}
            >
              <option value="">未分组</option>
              {config.groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>默认 shell</label>
            <select
              value={draft.defaultShell}
              onChange={(event) => setDraft({ ...draft, defaultShell: event.target.value as ShellId })}
            >
              {SHELL_OPTIONS.map((shell) => (
                <option key={shell.id} value={shell.id}>
                  {shell.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>启动命令（可选）</label>
            <input
              value={draft.initCmd}
              placeholder="npm run dev"
              onChange={(event) => setDraft({ ...draft, initCmd: event.target.value })}
            />
            <p className="hint">Command Prompt 不支持启动命令；PowerShell 与 Windows Terminal 支持。</p>
          </div>
          <div className="add-row">
            <button className="primary" onClick={() => void saveDraft()}>
              保存
            </button>
            <button className="ghost" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </section>
      )}

      <section>
        <h2>诊断</h2>
        <ul className="diag">
          {SHELL_OPTIONS.map((shell) => (
            <li key={shell.id}>
              <span>{shell.label}</span>
              <span className={shells?.[shell.id] ? 'ok' : 'missing'}>
                {shells ? (shells[shell.id] ? '已安装' : '未找到') : '检测中…'}
              </span>
            </li>
          ))}
        </ul>
        <div className="add-row">
          <button className="ghost" onClick={() => api.openConfigDir().then(setConfigDir)}>
            打开配置目录
          </button>
          <span className="hint inline">{configDir}</span>
        </div>
      </section>
    </div>
  )
}
