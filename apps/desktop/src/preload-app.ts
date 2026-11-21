import type { FileSaveResult } from '@deepseek-ai/dsh-client-ui-file-actions/types'
/** Origin-scoped boot, native file selection, Nimi settings, and update presentation. */

import type { DesktopChannelState, DesktopChannelChangeResult } from '@deepseek-ai/dsh-client-ui-settings-general/types'
import type { DesktopShortcutInput, ShortcutConfigSnapshot, ShortcutSaveResult } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  DESKTOP_IPC,
  SCHEME,
  type DesktopUpdatePresentation,
  type DshDesktopProductApi,
  type NimiDesktopAccount,
  type NimiDesktopAiConfigOptionsQuery,
  type NimiDesktopAiConfigOptionsResult,
  type NimiDesktopAiConfigOverwriteInput,
  type NimiDesktopAiConfigOverwriteResult,
  type NimiDesktopAiConfigQuery,
  type NimiDesktopAiConfigSnapshot,
  type NimiDesktopBridge,
  type NimiDesktopHomeChatImportResult,
  type NimiDesktopHomeSection,
  type NimiDesktopIntegrationTargetView,
  type NimiDesktopState,
} from './ipc.ts'
import { PLATFORM_IPC } from './platform-ipc.ts'
import { markDocumentPlatform, syncWindowFullscreen } from './preload-platform.ts'
import { syncNativeTheme } from './preload-theme.ts'
import { syncWindowsAppearance } from './preload-windows.ts'
import { installMandatoryUpdateOverlay } from './preload-mandatory-overlay.ts'
import { createDesktopBrowserBridge } from './preload-browser.ts'
import type { FileDragHandle } from '@deepseek-ai/dsh-util-file-drag'

function createUpdateBridge(): NonNullable<DshDesktopProductApi['updates']> {
  return {
    channels: {
      get: () => ipcRenderer.invoke(DESKTOP_IPC.updatesChannelGet) as Promise<DesktopChannelState>,
      set: channel => ipcRenderer.invoke(DESKTOP_IPC.updatesChannelSet, channel) as Promise<DesktopChannelChangeResult>,
      subscribe(listener) {
        const handle = (_event: Electron.IpcRendererEvent, state: DesktopChannelState): void => { listener(state) }
        ipcRenderer.on(DESKTOP_IPC.updatesChannelChanged, handle)
        return () => { ipcRenderer.off(DESKTOP_IPC.updatesChannelChanged, handle) }
      },
    },
    status: () => ipcRenderer.invoke(DESKTOP_IPC.updatesStatus) as Promise<DesktopUpdatePresentation>,
    open: () => ipcRenderer.invoke(DESKTOP_IPC.updatesOpen) as Promise<void>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopUpdatePresentation): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.updatesPresentation, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.updatesPresentation, handle) }
    },
  }
}

async function readLocalAppAccount(): Promise<NimiDesktopAccount | undefined> {
  try {
    const response = await ipcRenderer.invoke('nimi:runtime:invoke', {
      command: 'nimi.shell.localApp.sessionStatus',
      payload: {},
    }) as {
      ok?: boolean
      value?: { currentUser?: { state?: string; value?: { displayName?: string; handle?: string } | null } }
    } | undefined
    const user = response?.ok === true && response.value?.currentUser?.state === 'ready'
      ? response.value.currentUser.value
      : undefined
    if (!user) return undefined
    const displayName = typeof user.displayName === 'string' && user.displayName.trim() ? user.displayName.trim() : undefined
    const handle = typeof user.handle === 'string' && user.handle.trim() ? user.handle.trim() : undefined
    if (!displayName && !handle) return undefined
    return { ...(displayName ? { displayName } : {}), ...(handle ? { handle } : {}) }
  } catch {
    return undefined
  }
}

async function enrichNimiState(state: NimiDesktopState): Promise<NimiDesktopState> {
  if (!state || state.status !== 'ready' || state.account !== undefined) return state
  const account = await readLocalAppAccount()
  return account ? { ...state, account } : state
}

function createNimiBridge(): NimiDesktopBridge {
  return {
    getState: async () => {
      const state = await ipcRenderer.invoke(DESKTOP_IPC.nimiStateGet) as NimiDesktopState
      return enrichNimiState(state)
    },
    subscribeState(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: NimiDesktopState): void => {
        if (state?.status === 'ready' && state.account === undefined) {
          void enrichNimiState(state).then(listener, () => { listener(state) })
        } else {
          listener(state)
        }
      }
      ipcRenderer.on(DESKTOP_IPC.nimiStateChanged, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.nimiStateChanged, handle) }
    },
    recheckSession: async () => {
      const state = await ipcRenderer.invoke(DESKTOP_IPC.nimiRecheck) as NimiDesktopState
      return enrichNimiState(state)
    },
    openHome: (section?: NimiDesktopHomeSection) => ipcRenderer.invoke(DESKTOP_IPC.nimiOpenHome, section) as Promise<void>,
    openSettings: () => ipcRenderer.invoke(DESKTOP_IPC.nimiSettings) as Promise<void>,
    adoptLatestRevision: (configRef?: string) => ipcRenderer.invoke(DESKTOP_IPC.nimiAdoptRevision, configRef) as Promise<void>,
    aiConfig: {
      get: (query?: NimiDesktopAiConfigQuery) =>
        ipcRenderer.invoke(DESKTOP_IPC.nimiAiConfigGet, query) as Promise<NimiDesktopAiConfigSnapshot>,
      listOptions: (query: NimiDesktopAiConfigOptionsQuery) =>
        ipcRenderer.invoke(DESKTOP_IPC.nimiAiConfigListOptions, query) as Promise<NimiDesktopAiConfigOptionsResult>,
      overwrite: (input: NimiDesktopAiConfigOverwriteInput) =>
        ipcRenderer.invoke(DESKTOP_IPC.nimiAiConfigOverwrite, input) as Promise<NimiDesktopAiConfigOverwriteResult>,
    },
    integrations: {
      listCatalog: () => ipcRenderer.invoke(DESKTOP_IPC.nimiIntegrationsList) as Promise<readonly NimiDesktopIntegrationTargetView[]>,
    },
    importHomeChat: (sourceJson: string) =>
      ipcRenderer.invoke(DESKTOP_IPC.nimiImportHomeChat, sourceJson) as Promise<NimiDesktopHomeChatImportResult>,
    subscribeOpenSession(listener) {
      const handle = (_event: Electron.IpcRendererEvent, sessionId: string): void => {
        if (typeof sessionId === 'string' && sessionId.length > 0) listener(sessionId)
      }
      ipcRenderer.on(DESKTOP_IPC.nimiOpenSession, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.nimiOpenSession, handle) }
    },
    subscribeOpenSettings(listener) {
      const handle = (_event: Electron.IpcRendererEvent, section?: string): void => {
        listener(typeof section === 'string' && section.length > 0 ? section : undefined)
      }
      ipcRenderer.on(DESKTOP_IPC.nimiOpenSettings, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.nimiOpenSettings, handle) }
    },
  }
}

/**
 * Lightweight pre-boot Access Gate rendered inside the main window if Nimi Home is signed out
 * or Runtime is unavailable before the Cordis client finishes booting. Once Cordis mounts
 * `NimiAccessGateOverlay` (`[data-nimi-access-gate="true"]`), this fallback removes itself.
 */
function installNimiPrebootGate(): void {
  const GATE_ID = 'dsh-nimi-preboot-gate'
  const removeGate = (): void => {
    document.getElementById(GATE_ID)?.remove()
  }
  const renderGate = (state: NimiDesktopState): void => {
    if (!document.body) return
    if (state.status !== 'signed-out' && state.status !== 'unavailable') {
      removeGate()
      return
    }
    if (document.querySelector('[data-nimi-access-gate="true"]') !== null) {
      removeGate()
      return
    }
    const isZh = (document.documentElement?.lang || navigator.language || '').toLowerCase().startsWith('zh')
    const dark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
    let host = document.getElementById(GATE_ID)
    if (!host) {
      host = document.createElement('div')
      host.id = GATE_ID
      host.setAttribute('role', 'dialog')
      host.setAttribute('aria-modal', 'true')
      document.body.append(host)
    }
    host.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99999', 'display:flex', 'align-items:center', 'justify-content:center',
      'padding:24px', `background:${dark ? '#111215' : '#f8f9fb'}`, `color:${dark ? '#f3f4f6' : '#111827'}`,
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    ].join(';')
    const title = state.status === 'signed-out'
      ? (isZh ? '请在 Nimi Home 中登录' : 'Sign in via Nimi Home')
      : (isZh ? 'Nimi Runtime 暂不可用' : 'Nimi Runtime unavailable')
    const description = state.status === 'signed-out'
      ? (isZh ? 'Nimi DSH 需要有效的 Nimi Home 会话才能访问您的工作区和模型配置。' : 'Nimi DSH needs an active Nimi Home session to access your workspace and models.')
      : (isZh ? '无法连接到 Nimi Runtime。请确认 Nimi Home 正在运行，然后重新检查访问权限。' : 'Could not reach Nimi Runtime. Ensure Nimi Home is running, then recheck access.')
    const detail = state.errorMessage || state.errorCode || ''

    const card = document.createElement('div')
    card.style.cssText = [
      'width:100%', 'max-width:420px', 'padding:28px', 'border-radius:16px',
      `background:${dark ? '#1b1d22' : '#ffffff'}`,
      `border:1px solid ${dark ? 'rgba(255,255,255,0.1)' : 'rgba(15,23,42,0.1)'}`,
      'box-shadow:0 20px 50px rgba(0,0,0,0.22)', 'display:flex', 'flex-direction:column', 'gap:14px',
    ].join(';')

    const badge = document.createElement('div')
    badge.textContent = 'Nimi DSH'
    badge.style.cssText = `font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:${dark ? '#93c5fd' : '#2563eb'};`

    const heading = document.createElement('h1')
    heading.textContent = title
    heading.style.cssText = 'margin:0;font-size:20px;line-height:28px;font-weight:600;'

    const body = document.createElement('p')
    body.textContent = description
    body.style.cssText = `margin:0;font-size:14px;line-height:22px;color:${dark ? '#cbd5e1' : '#4b5563'};`

    card.append(badge, heading, body)
    if (detail) {
      const code = document.createElement('div')
      code.textContent = detail
      code.style.cssText = `font-size:12px;line-height:18px;padding:8px 10px;border-radius:8px;background:${dark ? 'rgba(255,255,255,0.06)' : '#f3f4f6'};color:${dark ? '#94a3b8' : '#6b7280'};word-break:break-word;`
      card.append(code)
    }

    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;gap:10px;margin-top:6px;flex-wrap:wrap;'

    const openBtn = document.createElement('button')
    openBtn.type = 'button'
    openBtn.textContent = isZh ? '打开 Nimi Home' : 'Open Nimi Home'
    openBtn.style.cssText = 'flex:1;min-width:140px;height:38px;padding:0 16px;border:0;border-radius:10px;font-size:14px;font-weight:500;cursor:pointer;background:#2563eb;color:#ffffff;'
    openBtn.addEventListener('click', () => {
      void ipcRenderer.invoke(DESKTOP_IPC.nimiOpenHome, state.status === 'signed-out' ? 'account' : 'apps').catch(() => undefined)
    })

    const recheckBtn = document.createElement('button')
    recheckBtn.type = 'button'
    recheckBtn.textContent = isZh ? '重新检查访问' : 'Recheck access'
    recheckBtn.style.cssText = `flex:1;min-width:140px;height:38px;padding:0 16px;border:1px solid ${dark ? 'rgba(255,255,255,0.18)' : 'rgba(15,23,42,0.16)'};border-radius:10px;font-size:14px;font-weight:500;cursor:pointer;background:transparent;color:${dark ? '#f3f4f6' : '#111827'};`
    recheckBtn.addEventListener('click', () => {
      recheckBtn.disabled = true
      void ipcRenderer.invoke(DESKTOP_IPC.nimiRecheck).finally(() => { recheckBtn.disabled = false })
    })

    actions.append(openBtn, recheckBtn)
    card.append(actions)
    host.replaceChildren(card)
  }

  ipcRenderer.on(DESKTOP_IPC.nimiStateChanged, (_event, state: NimiDesktopState) => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { renderGate(state) }, { once: true })
    } else {
      renderGate(state)
    }
  })
}

function createProductApi(): DshDesktopProductApi {
  return {
    protocolVersion: 1,
    ...(process.argv.includes('--nimi-managed')
      ? { nimi: createNimiBridge() }
      : { updates: createUpdateBridge() }),
    fileActions: {
      save: request => ipcRenderer.invoke(DESKTOP_IPC.fileSave, request) as Promise<FileSaveResult>,
      readClipboardImage: url => ipcRenderer.invoke(DESKTOP_IPC.clipboardImageRead, url) as
        Promise<{ bytes: Uint8Array; mediaType: string }>,
    },
    browser: createDesktopBrowserBridge(),
    fileDrag: {
      prepare: (source, requestId) => ipcRenderer.invoke(DESKTOP_IPC.fileDragPrepare, source, requestId) as
        Promise<FileDragHandle | undefined>,
      cancel: (requestId) => { void ipcRenderer.invoke(DESKTOP_IPC.fileDragCancel, requestId).catch((_error: unknown) => {
        // Main-process shutdown cancels any remaining preparations.
      }) },
      start: handle => ipcRenderer.invoke(DESKTOP_IPC.fileDragStart, handle) as Promise<boolean>,
      release: (handle) => { void ipcRenderer.invoke(DESKTOP_IPC.fileDragRelease, handle).catch((_error: unknown) => {
        // Main-process shutdown also releases every prepared file.
      }) },
    },
    deviceInfo: () => ipcRenderer.invoke(DESKTOP_IPC.deviceInfo) as Promise<string>,
    keyboard: {
      closeWindow: revision => ipcRenderer.invoke(DESKTOP_IPC.shortcutsCloseWindow, revision) as Promise<void>,
      subscribe: (listener) => {
        const handle = (_event: Electron.IpcRendererEvent, input: DesktopShortcutInput): void => {
          if (input.kind === 'iframe') {
            const element = document.activeElement
            if (!(element instanceof HTMLIFrameElement) || !element.isConnected
              || !element.matches('iframe[data-sidebar-browser-frame], iframe[data-html-preview]')) return
            if (input.frameName === '' || element.name !== input.frameName) return
          }
          if (input.kind === 'webview') {
            const element = document.activeElement
            if (element?.matches('webview[data-sidebar-browser-frame]') !== true || !element.isConnected
              || input.frameName === '' || element.getAttribute('name') !== input.frameName) return
          }
          listener(input)
        }
        ipcRenderer.on(DESKTOP_IPC.shortcutsInput, handle)
        return () => { ipcRenderer.off(DESKTOP_IPC.shortcutsInput, handle) }
      },
    },
    shortcuts: {
      get: definitions => ipcRenderer.invoke(DESKTOP_IPC.shortcutsGet, definitions) as Promise<ShortcutConfigSnapshot>,
      edit: (edit, revision) => ipcRenderer.invoke(DESKTOP_IPC.shortcutsEdit, edit, revision) as Promise<ShortcutSaveResult>,
      recording: active => ipcRenderer.invoke(DESKTOP_IPC.shortcutsRecording, active) as Promise<void>,
      subscribe(listener) {
        const handle = (_event: Electron.IpcRendererEvent, snapshot: ShortcutConfigSnapshot): void => { listener(snapshot) }
        ipcRenderer.on(DESKTOP_IPC.shortcutsChanged, handle)
        return () => { ipcRenderer.off(DESKTOP_IPC.shortcutsChanged, handle) }
      },
    },
  }
}

if (location.protocol === `${SCHEME}:` && location.hostname === 'app') {
  contextBridge.exposeInMainWorld('dshOnboarding', {
    hasApiKey: () => ipcRenderer.invoke(DESKTOP_IPC.onboardingApiKey) as Promise<boolean>,
    setActive: (active: boolean) => { ipcRenderer.send(DESKTOP_IPC.onboardingActive, active) },
  })
  ipcRenderer.on(DESKTOP_IPC.enterWorkspace, () => {
    const body = document.body
    const previous = body.getAttribute('tabindex')
    body.tabIndex = -1
    body.focus({ preventScroll: true })
    if (previous === null) body.removeAttribute('tabindex')
    else body.setAttribute('tabindex', previous)
  })
  syncWindowsAppearance()
  if (process.platform === 'win32') installMandatoryUpdateOverlay()
  contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
    pick: () => ipcRenderer.invoke(DESKTOP_IPC.directoryPick) as Promise<string | null>,
  })
  // The composer cites dropped, picked, and pasted files and folders that
  // have a real path as `@path` references instead of uploading them; a
  // File without one (pasted bytes) answers '' and uploads as before.
  contextBridge.exposeInMainWorld('__DSH_HOST_PATHS__', {
    pathFor: (file: File) => webUtils.getPathForFile(file),
  })
  contextBridge.exposeInMainWorld('dshDesktopBoot', {
    ready: () => ipcRenderer.invoke(DESKTOP_IPC.boot) as Promise<unknown>,
    failed: (message: string) => ipcRenderer.invoke(DESKTOP_IPC.bootFailed, message) as Promise<void>,
  })
  contextBridge.exposeInMainWorld('dshPlatform', {
    open: (page: 'usage' | 'top-up', bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke(PLATFORM_IPC.open, page, bounds),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke(PLATFORM_IPC.bounds, bounds),
    close: () => ipcRenderer.invoke(PLATFORM_IPC.close),
  })
  if (process.argv.includes('--nimi-managed') && process.isMainFrame) {
    installNimiPrebootGate()
  }
}

markDocumentPlatform()
syncWindowFullscreen()
syncNativeTheme()
// Main-process IPC also verifies the owning window and top frame.
contextBridge.exposeInMainWorld('dshDesktop', location.protocol === `${SCHEME}:` && location.hostname === 'app' && process.isMainFrame ? createProductApi() : { protocolVersion: 1 })

if (location.protocol === `${SCHEME}:` && location.hostname === 'app') {
  contextBridge.exposeInMainWorld('__DSH_LOCALE__', {
    read: () => ipcRenderer.invoke(DESKTOP_IPC.localeBootstrap),
    onChange: (locale: string) => { ipcRenderer.send(DESKTOP_IPC.localeChanged, locale) },
  })
}
