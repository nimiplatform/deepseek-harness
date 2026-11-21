/** Type-only Electron update declarations shared by the settings UI and Desktop compatibility checks. */

/** Classified failure copy selected by the Web locale without exposing raw updater diagnostics. */
export type DesktopUpdateFailureKind =
  | 'configuration'
  | 'check'
  | 'check-network'
  | 'download'
  | 'download-network'
  | 'download-space'
  | 'download-permission'
  | 'download-busy'
  | 'install'
  | 'install-network'
  | 'stop-failed'
  | 'tasks-changed'
  | 'tasks-unavailable'
  | 'fullscreen-timeout'

/** Public semantic preload fields consumed by the settings row. */
export interface DesktopUpdatePresentation {
  readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly percent?: number
  readonly failure?: DesktopUpdateFailureKind
  readonly configurationError?: DesktopChannelState['error']
}

/** Optional carrier API; it cannot select artifacts or authorize installation. */
export interface DesktopUpdateBridge {
  readonly channels?: DesktopChannelBridge
  status(): Promise<DesktopUpdatePresentation>
  open(): Promise<void>
  subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
}

/** Shared carrier status for the account row and collapsed sidebar badge. */
export interface DesktopUpdateView {
  readonly presentation?: DesktopUpdatePresentation
  readonly failed: boolean
  readonly opening: boolean
}

/** Shell-owned channel choices exposed through the isolated preload. */
export type DesktopUpdateChannel = 'nightly' | 'stable'

/** Current runtime selection and application status; failure never implies a successful switch. */
export interface DesktopChannelState {
  readonly channel: DesktopUpdateChannel | null
  readonly packagedChannel: DesktopUpdateChannel
  readonly changing: boolean
  readonly error?: 'read' | 'format' | 'channel' | 'cleanup'
}

/** Outcome of one UI action; failures are not global updater state. */
export type DesktopChannelChangeResult =
  | { readonly kind: 'applied' | 'unchanged'; readonly state: DesktopChannelState }
  | { readonly kind: 'failed'; readonly state: DesktopChannelState; readonly reason: 'save' | 'format' | 'permission' | 'apply' | 'uncertain' }

/** UI choices persist in the shell configuration, independently of Host settings. */
export interface DesktopChannelBridge {
  /** @returns Current shell selection and application status, without reading disk again. */
  get(): Promise<DesktopChannelState>
  /**
   * @param channel - Explicit user choice to persist and apply.
   * @returns The resulting selection or failure; it does not authorize installation.
   */
  set(channel: DesktopUpdateChannel): Promise<DesktopChannelChangeResult>
  /**
   * @param listener - Receives changes made from any Desktop window.
   * @returns Removes this window's subscription.
   */
  subscribe(listener: (state: DesktopChannelState) => void): () => void
}

/** Reactive connection posture of the Nimi Desktop Host bridge. */
export type NimiDesktopConnectionStatus = 'connecting' | 'signed-out' | 'unavailable' | 'ready'

/** Non-authorizing account display metadata projected from the protected session. */
export interface NimiDesktopAccount {
  readonly displayName?: string
  readonly handle?: string
  readonly userId?: string
}

/** Reactive Nimi session & Runtime state published by Electron main to the renderer. */
export interface NimiDesktopState {
  readonly status: NimiDesktopConnectionStatus
  readonly appId: 'ai.nimi.dsh'
  readonly account?: NimiDesktopAccount
  readonly errorCode?: string
  readonly errorMessage?: string
}

/** Nimi Home navigation targets opened via canonical Desktop Open intents. */
export type NimiDesktopHomeSection = 'account' | 'apps' | 'ai-models' | 'integrations'

/** One granted integration operation exposed in the Settings Integrations view. */
export interface NimiDesktopIntegrationOperationView {
  readonly name: string
  readonly displayName?: string
  readonly description: string
  readonly effect: string
}

/** One Home-granted integration target projected without credentials. */
export interface NimiDesktopIntegrationTargetView {
  readonly targetRef: string
  readonly integrationId: string
  readonly displayName: string
  readonly accountLabel: string
  readonly kind: string
  readonly available: boolean
  readonly permittedOperations: readonly string[]
  readonly operations: readonly NimiDesktopIntegrationOperationView[]
}

/** Result of importing a `nimi.home-chat.v1` handoff JSON file into DSH. */
export interface NimiDesktopHomeChatImportResult {
  readonly sessionId: string
  readonly title: string
  readonly importedMessages: number
  readonly draft?: string
  readonly deduplicated: boolean
}

/** Named AIConfig record summary returned by `aiConfig.get()`. */
export interface NimiDesktopAiConfigRecord {
  readonly configRef: string
  readonly name: string
  readonly revision: string
  readonly isDefault: boolean
}

/** Portable capability intent sent to `aiConfig.overwrite()`. */
export interface NimiDesktopAiConfigIntent {
  readonly capabilityContract: string
  readonly requiredFeatures: readonly string[]
  readonly defaults?: Record<string, unknown>
  readonly route:
    | { readonly oneofKind: 'local'; readonly local: { readonly loadoutRef?: string } }
    | {
      readonly oneofKind: 'cloud'
      readonly cloud: {
        readonly connectorRef: string
        readonly implementation?: Record<string, unknown>
        readonly providerModelTarget: Record<string, unknown>
      }
    }
    | { readonly oneofKind: undefined }
}

/** Effective selection projection returned by `aiConfig.get()`. */
export interface NimiDesktopAiConfigEffectiveSelection {
  readonly capabilityContract: string
  readonly state: 'ready' | 'missing' | 'blocked' | 'unavailable'
  readonly localLoadoutRevision?: string
  readonly resource:
    | { readonly oneofKind: 'local'; readonly local: { readonly loadoutRef: string; readonly label: string } }
    | { readonly oneofKind: 'cloud'; readonly cloud: { readonly connector: { readonly connectorRef: string; readonly label: string }; readonly target: { readonly label: string; readonly providerModelTarget: Record<string, unknown> } } }
    | null
  readonly reasons: readonly string[]
}

/** Snapshot returned by `aiConfig.get()`. */
export interface NimiDesktopAiConfigSnapshot {
  readonly record?: NimiDesktopAiConfigRecord
  readonly records?: readonly NimiDesktopAiConfigRecord[]
  readonly config: { readonly capabilities?: readonly NimiDesktopAiConfigIntent[] } | null
  readonly revision: string
  readonly effectiveSelections: readonly NimiDesktopAiConfigEffectiveSelection[]
}

/** Query accepted by `aiConfig.get()`. */
export interface NimiDesktopAiConfigQuery {
  readonly configRef?: string
  readonly includeRecords?: boolean
}

/** Query accepted by `aiConfig.listOptions()`. */
export type NimiDesktopAiConfigOptionsQuery =
  | { readonly kind: 'local-loadouts'; readonly capabilityContract: string; readonly search?: string }
  | { readonly kind: 'cloud-connectors'; readonly capabilityContract: string; readonly search?: string }
  | { readonly kind: 'cloud-targets'; readonly capabilityContract: string; readonly connectorRef: string; readonly search?: string }
  | { readonly kind: 'preset-voices' }

/** Local loadout option returned by `aiConfig.listOptions()`. */
export interface NimiDesktopAiConfigLocalLoadoutOption {
  readonly loadoutRef: string
  readonly label: string
  readonly capabilityContract: string
  readonly state: 'ready' | 'blocked'
  readonly reasons: readonly string[]
}

/** Cloud connector option returned by `aiConfig.listOptions()`. */
export interface NimiDesktopAiConfigCloudConnectorOption {
  readonly connectorRef: string
  readonly label: string
  readonly provider: string
  readonly state: 'ready' | 'blocked'
  readonly reasons: readonly string[]
}

/** Cloud target option returned by `aiConfig.listOptions()`. */
export interface NimiDesktopAiConfigCloudTargetOption {
  readonly connectorRef: string
  readonly label: string
  readonly capabilityContract: string
  readonly implementation?: Record<string, unknown>
  readonly providerModelTarget: Record<string, unknown>
  readonly state: 'ready' | 'blocked'
  readonly reasons: readonly string[]
}

/** Option list result returned by `aiConfig.listOptions()`. */
export type NimiDesktopAiConfigOptionsResult =
  | { readonly kind: 'local-loadouts'; readonly options: readonly NimiDesktopAiConfigLocalLoadoutOption[]; readonly truncated: boolean }
  | { readonly kind: 'cloud-connectors'; readonly options: readonly NimiDesktopAiConfigCloudConnectorOption[]; readonly truncated: boolean }
  | { readonly kind: 'cloud-targets'; readonly options: readonly NimiDesktopAiConfigCloudTargetOption[]; readonly truncated: boolean }
  | { readonly kind: 'preset-voices'; readonly options: readonly { readonly voiceId: string; readonly name: string }[]; readonly truncated: boolean }

/** Record edit action accepted by `aiConfig.overwrite()`. */
export type NimiDesktopAiConfigRecordEdit =
  | { readonly configRef: string; readonly action: 'save' }
  | { readonly action: 'create'; readonly name: string }
  | { readonly configRef: string; readonly action: 'rename'; readonly name: string }
  | { readonly configRef: string; readonly action: 'make-default' | 'delete' }

/** Overwrite payload sent to `aiConfig.overwrite()`. */
export interface NimiDesktopAiConfigOverwriteInput {
  readonly record?: NimiDesktopAiConfigRecordEdit
  readonly expectedRevision: string
  readonly capabilities: readonly NimiDesktopAiConfigIntent[]
}

/** Overwrite result returned by `aiConfig.overwrite()`. */
export type NimiDesktopAiConfigOverwriteResult =
  | {
    readonly outcome: 'committed'
    readonly record?: NimiDesktopAiConfigRecord
    readonly config: { readonly capabilities?: readonly NimiDesktopAiConfigIntent[] }
    readonly revision: string
  }
  | {
    readonly outcome: 'conflict'
    readonly record?: NimiDesktopAiConfigRecord
    readonly config: { readonly capabilities?: readonly NimiDesktopAiConfigIntent[] } | null
    readonly revision: string
    readonly reasonCode: string
  }

/** Typed preload bridge exposed at `window.dshDesktop.nimi` in Nimi-managed Desktop. */
export interface NimiDesktopBridge {
  getState(): Promise<NimiDesktopState>
  subscribeState(listener: (state: NimiDesktopState) => void): () => void
  recheckSession(): Promise<NimiDesktopState>
  openHome(section?: NimiDesktopHomeSection): Promise<void>
  openSettings(): Promise<void>
  adoptLatestRevision?(configRef?: string): Promise<void>
  readonly aiConfig: {
    get(query?: NimiDesktopAiConfigQuery): Promise<NimiDesktopAiConfigSnapshot>
    listOptions(query: NimiDesktopAiConfigOptionsQuery): Promise<NimiDesktopAiConfigOptionsResult>
    overwrite(input: NimiDesktopAiConfigOverwriteInput): Promise<NimiDesktopAiConfigOverwriteResult>
  }
  readonly integrations: {
    listCatalog(): Promise<readonly NimiDesktopIntegrationTargetView[]>
  }
  importHomeChat(sourceJson: string): Promise<NimiDesktopHomeChatImportResult>
  subscribeOpenSession?(listener: (sessionId: string) => void): () => void
  subscribeOpenSettings?(listener: (section?: string) => void): () => void
}
