import { contextBridge, ipcRenderer } from 'electron'
import { installNimiElectronRuntimeBridge } from '@nimiplatform/kit/shell/electron/preload-cjs'
import { DESKTOP_IPC } from './ipc.ts'

installNimiElectronRuntimeBridge({ contextBridge, ipcRenderer })

// The settings surface and Kit share English and Chinese. Keep the document
// language in sync with the workspace while the user edits a configuration.
ipcRenderer.on(DESKTOP_IPC.localeChanged, (_event, locale: string) => {
  const language = locale === 'zh-CN' ? 'zh' : 'en'
  if (!document.documentElement || document.documentElement.lang === language) return
  document.documentElement.lang = language
  window.dispatchEvent(new Event('languagechange'))
})
