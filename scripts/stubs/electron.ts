/**
 * 测试用的 electron 桩（单元测试不跑在 Electron 里，但被测模块会 import electron）。
 *
 * 只提供「导入期不报错」所需的最小面：调用到未实现的方法会明确抛错，
 * 避免桩把真实逻辑掩盖掉。
 */

function notImpl(name: string): never {
  throw new Error(`测试桩未实现: ${name}`)
}

export const app = {
  isPackaged: false,
  getPath: (_name: string): string => process.cwd(),
  getAppPath: (): string => process.cwd(),
  whenReady: () => Promise.resolve(),
  on: (_event: string, _cb: (...args: unknown[]) => void): void => {},
  quit: (): void => {}
}

export const BrowserWindow = {
  getAllWindows: (): unknown[] => [],
  fromWebContents: (_wc: unknown): unknown => null
}

export const ipcMain = {
  handle: (_channel: string, _cb: (...args: unknown[]) => unknown): void => {},
  on: (_channel: string, _cb: (...args: unknown[]) => unknown): void => {}
}

export const ipcRenderer = {
  invoke: (_channel: string, ..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  on: (_channel: string, _cb: (...args: unknown[]) => void): void => {},
  removeListener: (_channel: string, _cb: (...args: unknown[]) => void): void => {}
}

export const contextBridge = {
  exposeInMainWorld: (_key: string, _api: unknown): void => {}
}

export const shell = {
  openPath: async (_path: string): Promise<string> => ''
}

export const clipboard = {
  readText: (): string => '',
  writeText: (_text: string): void => {}
}

export const dialog = {
  showOpenDialog: async (..._args: unknown[]): Promise<{ canceled: boolean; filePaths: string[] }> => ({
    canceled: true,
    filePaths: []
  })
}

export const session = {
  defaultSession: {
    setPermissionRequestHandler: (_cb: (...args: unknown[]) => void): void => {}
  }
}

export const Tray = class {
  constructor(_icon: unknown) {}
  setContextMenu(_menu: unknown): void {}
  setToolTip(_tip: string): void {}
  on(_event: string, _cb: (...args: unknown[]) => void): void {}
  popUpContextMenu(): void {}
  destroy(): void {}
}

export const Menu = {
  buildFromTemplate: (template: unknown[]): unknown => template
}

export const net = {
  isOnline: (): boolean => true
}

export const powerSaveBlocker = {
  start: (_type: string): number => 0,
  stop: (_id: number): void => {}
}

export default {
  app,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  contextBridge,
  shell,
  clipboard,
  dialog,
  session,
  Tray,
  Menu,
  net,
  powerSaveBlocker
}
