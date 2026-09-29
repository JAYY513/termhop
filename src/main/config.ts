import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type {
  AddEntryRequest,
  Config,
  Entry,
  Group,
  HistoryItem,
  LauncherPlacement,
  ShellId,
  TrashItem
} from '@shared/types'

export const CONFIG_VERSION = 1
export const TRASH_LIMIT = 50

const SHELL_IDS: ShellId[] = ['pwsh', 'powershell', 'cmd', 'wt']

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** Expands `~` and resolves to an absolute path, dropping any trailing slash. */
export function normalizePath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  const expanded = trimmed.startsWith('~')
    ? (process.env.USERPROFILE || process.env.HOME || '') + trimmed.slice(1)
    : trimmed
  const absolute = resolve(expanded)
  return absolute.length > 3 ? absolute.replace(/[\\/]+$/, '') : absolute
}

export function folderNameOf(fullPath: string): string {
  const parts = normalizePath(fullPath).split(/[\\/]/)
  return parts[parts.length - 1] || fullPath
}

export function defaultConfig(): Config {
  return {
    version: CONFIG_VERSION,
    hotkey: 'CmdOrCtrl+Space',
    groups: [],
    entries: [],
    history: [],
    trash: [],
    placement: { mode: 'cursor', point: null },
    settings: {
      restoreLastShell: true,
      closeOnBlur: true,
      launchOnStartup: false,
      maxHistory: 200,
      recentCount: 5
    }
  }
}

export function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

let cached: Config | null = null
const notices: string[] = []

/**
 * Startup problems worth telling the user about. The config file is
 * hand-editable, so "it silently came back empty" would be indistinguishable
 * from "I never had anything saved".
 */
export function consumeNotices(): string[] {
  return notices.splice(0, notices.length)
}

/* ------------------------------------------------------------- normalising */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const asBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const asShell = (value: unknown, fallback: ShellId): ShellId =>
  typeof value === 'string' && (SHELL_IDS as string[]).includes(value)
    ? (value as ShellId)
    : fallback

function normalizeGroup(raw: Record<string, unknown>, index: number): Group {
  return {
    id: asString(raw.id) || `group-${index + 1}`,
    name: asString(raw.name, `Group ${index + 1}`),
    order: asNumber(raw.order, index)
  }
}

function normalizeEntry(
  raw: Record<string, unknown>,
  groupIds: Set<string>,
  seenIds: Set<string>,
  index: number
): Entry {
  let id = asString(raw.id) || `entry-${index + 1}`
  while (seenIds.has(id)) id = `${id}-dup`
  seenIds.add(id)
  const groupId = asString(raw.groupId, '')
  return {
    id,
    title: asString(raw.title),
    path: asString(raw.path),
    groupId: groupId && groupIds.has(groupId) ? groupId : null,
    defaultShell: asShell(raw.defaultShell, 'powershell'),
    // Absent means "never used", which must stay null so the launcher
    // falls back to defaultShell instead of being pinned to powershell.
    lastShell: raw.lastShell == null ? null : asShell(raw.lastShell, 'powershell'),
    initCmd: typeof raw.initCmd === 'string' && raw.initCmd ? raw.initCmd : null,
    order: asNumber(raw.order, index)
  }
}

/**
 * The config file is hand-editable on purpose, so every field is treated as
 * untrusted input and repaired here rather than trusted downstream.
 */
function normalize(raw: unknown): Config {
  const base = defaultConfig()
  if (!isRecord(raw)) return base

  const groups: Group[] = Array.isArray(raw.groups)
    ? raw.groups.filter(isRecord).map((g, i) => normalizeGroup(g, i))
    : []

  const groupIds = new Set(groups.map((g) => g.id))
  const seenIds = new Set<string>()

  const entries: Entry[] = Array.isArray(raw.entries)
    ? raw.entries.filter(isRecord).map((e, i) => normalizeEntry(e, groupIds, seenIds, i))
    : []

  const entryIds = new Set(entries.map((e) => e.id))
  const history: HistoryItem[] = Array.isArray(raw.history)
    ? raw.history
        .filter(isRecord)
        .filter((h) => entryIds.has(asString(h.entryId)))
        .map((h) => ({
          entryId: asString(h.entryId),
          shell: asShell(h.shell, 'powershell'),
          at: asNumber(h.at, 0)
        }))
        .sort((a, b) => b.at - a.at)
    : []

  const settings = isRecord(raw.settings) ? raw.settings : {}
  const maxHistory = Math.min(1000, Math.max(10, asNumber(settings.maxHistory, base.settings.maxHistory)))
  const recentCount = Math.min(20, Math.max(0, asNumber(settings.recentCount, base.settings.recentCount)))

  const trash: TrashItem[] = Array.isArray(raw.trash)
    ? raw.trash
        .filter(isRecord)
        .map((item, i) => ({
          id: asString(item.id) || `trash-${i + 1}`,
          kind: item.kind === 'group' ? ('group' as const) : ('entry' as const),
          deletedAt: asNumber(item.deletedAt, 0),
          entry: isRecord(item.entry) ? normalizeEntry(item.entry, groupIds, new Set(), i) : undefined,
          group: isRecord(item.group) ? normalizeGroup(item.group, i) : undefined,
          memberEntryIds: Array.isArray(item.memberEntryIds)
            ? item.memberEntryIds.filter((v): v is string => typeof v === 'string')
            : undefined
        }))
        // A snapshot missing the object it needs can never be restored.
        .filter((item) => (item.kind === 'group' ? Boolean(item.group) : Boolean(item.entry)))
        .slice(0, TRASH_LIMIT)
    : []

  const rawPlacement: Record<string, unknown> = isRecord(raw.placement) ? raw.placement : {}
  const rawPoint: Record<string, unknown> = isRecord(rawPlacement.point) ? rawPlacement.point : {}
  const placement: LauncherPlacement = {
    mode:
      rawPlacement.mode === 'fixed' || rawPlacement.mode === 'center'
        ? rawPlacement.mode
        : 'cursor',
    point:
      typeof rawPoint.x === 'number' && typeof rawPoint.y === 'number'
        ? { x: Math.round(rawPoint.x), y: Math.round(rawPoint.y) }
        : null
  }

  return {
    version: CONFIG_VERSION,
    hotkey: asString(raw.hotkey, base.hotkey),
    groups: groups.sort((a, b) => a.order - b.order).map((g, i) => ({ ...g, order: i })),
    entries: entries.sort((a, b) => a.order - b.order).map((e, i) => ({ ...e, order: i })),
    history: history.slice(0, maxHistory),
    trash,
    placement,
    settings: {
      restoreLastShell: asBool(settings.restoreLastShell, base.settings.restoreLastShell),
      closeOnBlur: asBool(settings.closeOnBlur, base.settings.closeOnBlur),
      launchOnStartup: asBool(settings.launchOnStartup, base.settings.launchOnStartup),
      maxHistory,
      recentCount
    }
  }
}

/* ------------------------------------------------------------- persistence */

export function loadConfig(): Config {
  if (cached) return cached
  const file = configPath()
  try {
    if (existsSync(file)) {
      cached = normalize(JSON.parse(readFileSync(file, 'utf8')))
      return cached
    }
  } catch (error) {
    // A broken config must never stop the app from starting. Keep a copy so
    // the user can recover by hand, then continue with defaults.
    console.error('[config] failed to read, falling back to defaults:', error)
    let backup = `${file}.broken-${Date.now()}`
    try {
      if (existsSync(file)) {
        renameSync(file, backup)
        backup = backup.slice(file.length + 7)
      }
    } catch {
      /* best effort */
    }
    notices.push(
      `配置文件读不出来，已经用默认设置启动。原文件备份为 config.json${backup}，` +
        '到设置 → 诊断 → 打开配置目录可以查看。'
    )
  }
  cached = defaultConfig()
  return cached
}

export function saveConfig(next: Config): Config {
  const clean = normalize(next)
  const file = configPath()
  mkdirSync(dirname(file), { recursive: true })
  // Write-then-rename so a crash mid-write cannot truncate the config.
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  cached = clean
  return clean
}

export function invalidateCache(): void {
  cached = null
}

/* -------------------------------------------------------------- mutations */

export interface MutationResult {
  ok: boolean
  error?: string
  config: Config
}

function reindex(entries: Entry[]): Entry[] {
  return entries.map((entry, i) => (entry.order === i ? entry : { ...entry, order: i }))
}

export function addEntryToConfig(config: Config, request: AddEntryRequest): MutationResult & { entryId?: string } {
  const path = normalizePath(request.path)
  if (!path) return { ok: false, error: '请填写目录路径', config }

  const clash = config.entries.find(
    (entry) => normalizePath(entry.path).toLowerCase() === path.toLowerCase()
  )
  if (clash) {
    return { ok: false, error: `这个目录已经在列表里了：${clash.title || clash.path}`, config }
  }

  const groupId =
    request.groupId && config.groups.some((group) => group.id === request.groupId)
      ? request.groupId
      : null

  const entry: Entry = {
    id: uid('entry'),
    path,
    title: (request.title ?? '').trim(),
    groupId,
    defaultShell: request.defaultShell ?? 'powershell',
    lastShell: null,
    initCmd: request.initCmd?.trim() || null,
    order: config.entries.length
  }

  return {
    ok: true,
    entryId: entry.id,
    config: { ...config, entries: [...config.entries, entry] }
  }
}

/** Moves an entry to the trash and forgets its history. */
export function trashEntryInConfig(config: Config, entryId: string): MutationResult {
  const entry = config.entries.find((item) => item.id === entryId)
  if (!entry) return { ok: false, error: '这个目录已经不存在了', config }

  const item: TrashItem = { id: uid('trash'), kind: 'entry', deletedAt: Date.now(), entry }
  return {
    ok: true,
    config: {
      ...config,
      entries: reindex(config.entries.filter((candidate) => candidate.id !== entryId)),
      history: config.history.filter((h) => h.entryId !== entryId),
      trash: [item, ...config.trash].slice(0, TRASH_LIMIT)
    }
  }
}

/**
 * Deletes a group. Its members are kept and fall back to "ungrouped", and the
 * membership is recorded so a restore can put it back exactly.
 */
export function trashGroupInConfig(config: Config, groupId: string): MutationResult {
  const group = config.groups.find((item) => item.id === groupId)
  if (!group) return { ok: false, error: '这个分组已经不存在了', config }

  const memberEntryIds = config.entries
    .filter((entry) => entry.groupId === groupId)
    .map((entry) => entry.id)

  const item: TrashItem = { id: uid('trash'), kind: 'group', deletedAt: Date.now(), group, memberEntryIds }
  return {
    ok: true,
    config: {
      ...config,
      groups: config.groups
        .filter((candidate) => candidate.id !== groupId)
        .map((candidate, i) => ({ ...candidate, order: i })),
      entries: config.entries.map((entry) =>
        entry.groupId === groupId ? { ...entry, groupId: null } : entry
      ),
      trash: [item, ...config.trash].slice(0, TRASH_LIMIT)
    }
  }
}

export function restoreFromTrash(config: Config, trashId: string): MutationResult {
  const item = config.trash.find((candidate) => candidate.id === trashId)
  if (!item) return { ok: false, error: '回收站里没有这一项了', config }

  if (item.kind === 'entry' && item.entry) {
    const restored: Entry = { ...item.entry, order: config.entries.length }
    return {
      ok: true,
      config: {
        ...config,
        entries: [...config.entries, restored],
        trash: config.trash.filter((candidate) => candidate.id !== trashId)
      }
    }
  }

  if (item.kind === 'group' && item.group) {
    const group = { ...item.group, order: config.groups.length }
    const members = new Set(item.memberEntryIds ?? [])
    return {
      ok: true,
      config: {
        ...config,
        groups: [...config.groups, group],
        // Only reassign members that still exist.
        entries: config.entries.map((entry) =>
          members.has(entry.id) ? { ...entry, groupId: group.id } : entry
        ),
        trash: config.trash.filter((candidate) => candidate.id !== trashId)
      }
    }
  }

  return { ok: false, error: '这一项的数据不完整，无法恢复', config }
}

export function purgeFromTrash(config: Config, trashId: string): MutationResult {
  if (!config.trash.some((item) => item.id === trashId)) {
    return { ok: false, error: '回收站里没有这一项了', config }
  }
  return {
    ok: true,
    config: { ...config, trash: config.trash.filter((item) => item.id !== trashId) }
  }
}

export function clearTrash(config: Config): MutationResult {
  return { ok: true, config: { ...config, trash: [] } }
}
