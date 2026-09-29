import { contextBridge, ipcRenderer } from 'electron'
import type {
  AddEntryRequest,
  Config,
  OpenResult,
  OpenTarget,
  PlacementMode,
  ShellAvailability,
  TermHopApi,
  TermHopEvents
} from '@shared/types'

const api: TermHopApi = {
  platform: process.platform,

  getVersion: () => ipcRenderer.invoke('app:version'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config: Config) => ipcRenderer.invoke('config:save', config),
  addEntry: (request: AddEntryRequest) => ipcRenderer.invoke('entry:add', request),
  openPath: (cwd: string) => ipcRenderer.invoke('entry:openPath', cwd),
  openEntry: (entryId: string, target: OpenTarget): Promise<OpenResult> =>
    ipcRenderer.invoke('entry:open', entryId, target),
  trashEntry: (id: string) => ipcRenderer.invoke('entry:trash', id),
  trashGroup: (id: string) => ipcRenderer.invoke('group:trash', id),
  trashRestore: (id: string) => ipcRenderer.invoke('trash:restore', id),
  trashPurge: (id: string) => ipcRenderer.invoke('trash:purge', id),
  trashClear: () => ipcRenderer.invoke('trash:clear'),
  checkShells: (): Promise<ShellAvailability> => ipcRenderer.invoke('shell:check'),
  setHotkey: (accelerator: string) => ipcRenderer.invoke('hotkey:set', accelerator),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  openConfigDir: () => ipcRenderer.invoke('config:openDir'),
  installCli: () => ipcRenderer.invoke('cli:install'),
  addCliToPath: () => ipcRenderer.invoke('cli:addToPath'),
  getPlacement: () => ipcRenderer.invoke('launcher:placement'),
  setPlacementMode: (mode: PlacementMode) => ipcRenderer.invoke('launcher:setPlacement', mode),
  getNotices: () => ipcRenderer.invoke('app:notices'),
  setAutoLaunch: (enabled: boolean) => ipcRenderer.invoke('app:autoLaunch', enabled),
  getAutoLaunchState: () => ipcRenderer.invoke('app:autoLaunchState'),
  setCloseOnBlur: (enabled: boolean) => ipcRenderer.send('window:closeOnBlur', enabled),
  hideLauncher: () => ipcRenderer.send('launcher:hide'),
  showLauncher: () => ipcRenderer.send('launcher:show'),
  resizeLauncher: (contentHeight: number) => ipcRenderer.send('launcher:resize', contentHeight),
  openSettings: () => ipcRenderer.send('nav:settings'),
  beginAddEntry: () => ipcRenderer.send('nav:beginAdd'),
  consumeBeginAdd: () => ipcRenderer.invoke('ui:consumeBeginAdd'),
  closeSettings: () => ipcRenderer.send('nav:closeSettings'),
  quit: () => ipcRenderer.send('app:quit'),

  on: <K extends keyof TermHopEvents>(channel: K, handler: (payload: TermHopEvents[K]) => void) => {
    const listener = (_event: unknown, payload: TermHopEvents[K]): void => handler(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

contextBridge.exposeInMainWorld('termhop', api)
