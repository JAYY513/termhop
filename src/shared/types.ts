export type ShellId = 'pwsh' | 'powershell' | 'cmd' | 'wt'

export interface Group {
  id: string
  name: string
  order: number
}

export interface Entry {
  id: string
  /** User-facing name. Falls back to the folder name when empty. */
  title: string
  /** Absolute path to the working directory. */
  path: string
  /** null means "Ungrouped". */
  groupId: string | null
  defaultShell: ShellId
  /** Last shell actually used for this entry, restored on the next open. */
  lastShell: ShellId | null
  /** Optional command to run right after cd. PowerShell and Windows Terminal only. */
  initCmd: string | null
  order: number
}

export interface HistoryItem {
  entryId: string
  shell: ShellId
  at: number
}

/**
 * A deleted object kept so it can be put back. Groups additionally remember
 * which entries used to belong to them, otherwise restoring a group would
 * silently lose that assignment.
 */
export interface TrashItem {
  id: string
  kind: 'entry' | 'group'
  deletedAt: number
  entry?: Entry
  group?: Group
  memberEntryIds?: string[]
}

export type PlacementMode = 'cursor' | 'center' | 'fixed'

export interface LauncherPlacement {
  /** Where the launcher pops up: at the pointer, centred, or at a dragged spot. */
  mode: PlacementMode
  point: { x: number; y: number } | null
}

export interface AppSettings {
  /** Reuse the shell used the previous time instead of the default one. */
  restoreLastShell: boolean
  closeOnBlur: boolean
  launchOnStartup: boolean
  maxHistory: number
  recentCount: number
}

export interface Config {
  version: number
  hotkey: string
  groups: Group[]
  entries: Entry[]
  history: HistoryItem[]
  /** Deleted groups and entries, newest first. */
  trash: TrashItem[]
  placement: LauncherPlacement
  settings: AppSettings
}

/**
 * - a ShellId opens with that exact shell
 * - 'last' opens with the remembered shell (falls back to the default)
 * - 'default' opens with the configured default shell
 * - 'reveal' opens the folder in Explorer
 */
export type OpenTarget = ShellId | 'last' | 'default' | 'reveal'

export interface OpenResult {
  ok: boolean
  error?: string
  shell?: ShellId
}

export interface AddEntryRequest {
  path: string
  title?: string
  groupId?: string | null
  defaultShell?: ShellId
  initCmd?: string | null
}

export interface AddEntryResult {
  ok: boolean
  error?: string
  entryId?: string
  config: Config
}

export interface CliInstallResult {
  shimPath: string
  /** Whether the shim's folder is already on the user PATH. */
  onPath: boolean
}

export interface AutoLaunchState {
  /** The real value as Windows reports it, which a user can change elsewhere. */
  enabled: boolean
  /** False in development builds, which never register a login item. */
  supported: boolean
}

export type ShellAvailability = Record<ShellId, boolean>

/** Events pushed from the main process to the renderer. */
export interface TermHopEvents {
  'launcher:shown': void
  'config:changed': Config
  'nav:settings': void
}

export interface TermHopApi {
  platform: string
  getVersion(): Promise<string>
  getConfig(): Promise<Config>
  saveConfig(config: Config): Promise<Config>
  addEntry(request: AddEntryRequest): Promise<AddEntryResult>
  openEntry(entryId: string, target: OpenTarget): Promise<OpenResult>
  /**
   * Opens a terminal in a directory that is not saved. No config change, so
   * this never pollutes the entry list.
   */
  openPath(cwd: string): Promise<OpenResult>
  /** Moves to the trash rather than deleting outright. Returns the new config. */
  trashEntry(id: string): Promise<Config>
  trashGroup(id: string): Promise<Config>
  trashRestore(id: string): Promise<Config>
  trashPurge(id: string): Promise<Config>
  trashClear(): Promise<Config>
  checkShells(): Promise<ShellAvailability>
  setHotkey(accelerator: string): Promise<{ ok: boolean; error?: string }>
  pickDirectory(): Promise<string | null>
  openConfigDir(): Promise<string>
  installCli(): Promise<CliInstallResult>
  addCliToPath(): Promise<{ ok: boolean; onPath: boolean; error?: string }>
  getPlacement(): Promise<LauncherPlacement>
  setPlacementMode(mode: PlacementMode): Promise<LauncherPlacement>
  /** Startup problems worth showing the user, drained on first read. */
  getNotices(): Promise<string[]>
  setAutoLaunch(enabled: boolean): Promise<boolean>
  getAutoLaunchState(): Promise<AutoLaunchState>
  setCloseOnBlur(enabled: boolean): void
  hideLauncher(): void
  showLauncher(): void
  /** Asks the main process to shrink the launcher to its content height. */
  resizeLauncher(contentHeight: number): void
  openSettings(): void
  beginAddEntry(): void
  /**
   * Reads and clears the pending "open the add form" request. Pulled on mount
   * rather than pushed, because the settings window may still be loading when
   * the request is made.
   */
  consumeBeginAdd(): Promise<boolean>
  closeSettings(): void
  quit(): void
  on<K extends keyof TermHopEvents>(
    channel: K,
    handler: (payload: TermHopEvents[K]) => void
  ): () => void
}
