/** Client-owned observation of the Nimi Desktop preload bridge. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  NimiDesktopBridge,
  NimiDesktopHomeChatImportResult,
  NimiDesktopHomeSection,
  NimiDesktopState,
} from '../types.ts'

/** Settings bridge with optional account and configuration operations. */
export type PartialNimiDesktopBridge = Partial<NimiDesktopBridge> & Pick<NimiDesktopBridge, 'openSettings'>

const DEFAULT_READY_STATE: NimiDesktopState = {
  status: 'ready',
  appId: 'ai.nimi.dsh',
}

const DEFAULT_CONNECTING_STATE: NimiDesktopState = {
  status: 'connecting',
  appId: 'ai.nimi.dsh',
}

/** Owns one reactive preload subscription shared by launcher, sections, and Access Gate. */
export class NimiDesktopSource {
  /** The latest Desktop access state for client subscribers. */
  readonly store: ReturnType<typeof createSnapshotStore<NimiDesktopState>>
  private live = true
  private received = false
  private readonly unsubscribe: (() => void) | undefined

  constructor(private readonly bridge: PartialNimiDesktopBridge | undefined) {
    const hasLifecycle = typeof bridge?.getState === 'function' || typeof bridge?.subscribeState === 'function'
    this.store = createSnapshotStore<NimiDesktopState>(hasLifecycle ? DEFAULT_CONNECTING_STATE : DEFAULT_READY_STATE)
    if (typeof bridge?.subscribeState === 'function') {
      this.unsubscribe = bridge.subscribeState((state) => {
        if (!this.live) return
        this.received = true
        this.store.set(state)
      })
    }
    if (typeof bridge?.getState === 'function') {
      void bridge.getState().then((state) => {
        if (this.live && !this.received) this.store.set(state)
      }, () => {
        if (this.live && !this.received) {
          this.store.set({ status: 'unavailable', appId: 'ai.nimi.dsh' })
        }
      })
    }
  }

  /**
   * Refresh access through the Desktop session provider when available.
   * @returns The latest access state.
   */
  async recheck(): Promise<NimiDesktopState> {
    if (!this.live || typeof this.bridge?.recheckSession !== 'function') {
      return this.store.getSnapshot()
    }
    const next = await this.bridge.recheckSession()
    if (this.live) {
      this.received = true
      this.store.set(next)
    }
    return next
  }

  /**
   * Open Nimi Home, or open the App settings when Home navigation is unavailable.
   * @param section - The optional destination in Nimi Home.
   */
  async openHome(section?: NimiDesktopHomeSection): Promise<void> {
    if (typeof this.bridge?.openHome === 'function') {
      await this.bridge.openHome(section)
      return
    }
    await this.bridge?.openSettings()
  }

  /** Open the App settings window. */
  async openSettings(): Promise<void> {
    await this.bridge?.openSettings()
  }

  /**
   * Acknowledge the current revision of a Nimi configuration.
   * @param configRef - The configuration to adopt, or the default configuration when omitted.
   */
  async adoptLatestRevision(configRef?: string): Promise<void> {
    if (typeof this.bridge?.adoptLatestRevision === 'function') {
      await this.bridge.adoptLatestRevision(configRef)
    }
  }

  /**
   * Import a conversation exported by Nimi Home.
   * @param sourceJson - The contents of the Home chat export.
   * @returns The session corresponding to the export.
   */
  async importHomeChat(sourceJson: string): Promise<NimiDesktopHomeChatImportResult> {
    if (typeof this.bridge?.importHomeChat !== 'function') {
      throw new Error('Home chat import is not available in this desktop host.')
    }
    return this.bridge.importHomeChat(sourceJson)
  }

  /** Release the Desktop state subscription and discard outstanding updates. */
  dispose(): void {
    this.live = false
    this.unsubscribe?.()
  }
}
