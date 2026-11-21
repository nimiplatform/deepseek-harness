/** Translate one DSH model step to the protected Nimi text-turn contract with stable configRef binding and revision conflict recovery. */
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  offloadedImageText,
  projectOffloadedImages,
  ReasoningEffortId,
  ToolCallId,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type {
  NimiLocalAppTextTurnEvent,
  NimiLocalAppTextTurnInput,
} from '@nimiplatform/sdk/app'
import {
  nimiFailure,
  type NimiEnsureRouteRequest,
  type NimiEnsureRouteResult,
  type NimiModelChoice,
  type NimiModelInfo,
  type NimiRouteCatalog,
} from './nimi-text-client.ts'
import type { NimiJsonObject } from '@nimiplatform/sdk/contracts'

export const NIMI_LOCAL_PROVIDER_ID = 'nimi-local'
export const NIMI_CLOUD_PROVIDER_PREFIX = 'nimi-cloud.'
export const NIMI_LOCAL_UNCONFIGURED_MODEL_ID = 'local-unconfigured'

export interface NimiModelAdapterRoutes {
  listRoutes(signal?: AbortSignal): Promise<NimiRouteCatalog>
  ensureRouteConfig(request: NimiEnsureRouteRequest, signal?: AbortSignal): Promise<NimiEnsureRouteResult>
  onCatalogChanged?(): void
}

type Message = NimiLocalAppTextTurnInput['messages'][number]
type Item = NonNullable<Message['turnItems']>[number]
type Part = NonNullable<Message['parts']>[number]
type Continuity = Extract<NimiLocalAppTextTurnEvent, { type: 'reasoning-continuity' }>['carrier']
type StreamTurn = (input: NimiLocalAppTextTurnInput, signal?: AbortSignal) => AsyncIterable<NimiLocalAppTextTurnEvent>
type ImageRef = Extract<ContentBlock, { type: 'image' }>['attachment']
type ResolveImage = (ref: ImageRef, signal?: AbortSignal) => Promise<string>
const textEnvelope = { maxMessages: 128, maxBytes: 1024 * 1024 } as const

export type ParsedNimiModelId =
  | { readonly kind: 'default' }
  | { readonly kind: 'named'; readonly configRef: string; readonly legacyHash?: string }

/**
 * Parse stable Nimi model IDs (`configured`, `config.<configRef>`) and legacy hashed IDs
 * (`config.<configRef>.<sha256>`) so persisted sessions and subagent allowlists never crash.
 */
export function parseNimiModelId(model: string, defaultModelId: string): ParsedNimiModelId | undefined {
  if (model === defaultModelId) return { kind: 'default' }
  const [, configRef, legacyHash] = /^config\.(main|[a-f0-9]{32})(?:\.([a-f0-9]{64}))?$/.exec(model) ?? []
  return configRef === undefined ? undefined : { kind: 'named', configRef, ...(legacyHash === undefined ? {} : { legacyHash }) }
}

interface ObservedRevision {
  readonly configRef: string
  readonly expectedRevision: string
  readonly expectedLocalLoadoutRef?: string
  readonly expectedLocalLoadoutRevision?: string
  readonly revisionIdentity?: string
  readonly targetLabel?: string
}

/** A DSH effort represents one admitted Nimi input. An omitted choice follows the configured route. */
function reasoningChoices(capabilities: NimiModelInfo['reasoningInput']) {
  const choices: { id: ReasoningEffortId; name: string; input: NonNullable<NimiLocalAppTextTurnInput['reasoning']> }[] = []
  if (!capabilities) return choices
  if (capabilities.supportsDisabled && capabilities.presentations.includes('hidden')) {
    choices.push({ id: ReasoningEffortId('off'), name: 'Off', input: { activation: 'disabled' } })
  }
  const activation = capabilities.supportsRequired ? 'required' : capabilities.supportsAdaptive ? 'adaptive' : undefined
  const presentation = capabilities.presentations.includes('hidden') ? 'hidden' : capabilities.presentations[0]
  if (activation && presentation) {
    for (const effort of capabilities.efforts) {
      const name = effort === 'model-default' ? 'Model-selected intensity' : effort
      choices.push({ id: ReasoningEffortId(effort), name, input: { activation, effort, presentation } })
    }
  }
  return choices
}

function revisionsMatch(observed: ObservedRevision, current: NonNullable<NimiModelInfo['configuration']>, currentIdentity?: string): boolean {
  if (observed.configRef !== current.configRef) return false
  if (observed.expectedRevision !== current.expectedRevision) return false
  if ((observed.expectedLocalLoadoutRef ?? '') !== (current.expectedLocalLoadoutRef ?? '')) return false
  if ((observed.expectedLocalLoadoutRevision ?? '') !== (current.expectedLocalLoadoutRevision ?? '')) return false
  if (observed.revisionIdentity && currentIdentity && observed.revisionIdentity !== currentIdentity) return false
  return true
}

/** The caller supplies the Host channel. The adapter has no endpoint or credentials. */
export class NimiModelAdapter extends LlmAdapter {
  private readonly observed = new Map<string, ObservedRevision>()
  private readonly adoptedLegacyModels = new Set<string>()
  private cachedRoutes: NimiRouteCatalog | undefined
  private cachedRoutesAt = 0
  private pendingRoutes: Promise<NimiRouteCatalog> | undefined

  constructor(
    private readonly model: LlmModelInfo,
    private readonly streamTurn: StreamTurn,
    private readonly resolveImage?: ResolveImage,
    private readonly readInfo?: (signal?: AbortSignal, configRef?: string) => Promise<NimiModelInfo>,
    private readonly listChoices?: () => Promise<readonly NimiModelChoice[]>,
    private readonly routes?: NimiModelAdapterRoutes,
  ) { super() }

  /** Refresh cached Cloud/Local route catalog from the Host and return it. */
  async refreshRoutes(signal?: AbortSignal, force = true): Promise<NimiRouteCatalog | undefined> {
    if (!this.routes) return undefined
    const now = Date.now()
    if (!force && this.cachedRoutes && now - this.cachedRoutesAt < 1500) {
      return this.cachedRoutes
    }
    if (!force && this.pendingRoutes) {
      return this.pendingRoutes
    }
    const loader = this.routes.listRoutes(signal).then((catalog) => {
      this.cachedRoutes = catalog
      this.cachedRoutesAt = Date.now()
      return catalog
    }).finally(() => {
      if (this.pendingRoutes === loader) this.pendingRoutes = undefined
    })
    this.pendingRoutes = loader
    return loader
  }

  /** Return all currently active provider IDs (saved configs + Local + ready Cloud connectors). */
  providerIds(): string[] {
    if (!this.routes) return [this.model.provider]
    const cloudProviders = (this.cachedRoutes?.cloudConnectors ?? [])
      .map(connector => `${NIMI_CLOUD_PROVIDER_PREFIX}${connector.connectorRef}`)
    return [this.model.provider, NIMI_LOCAL_PROVIDER_ID, ...cloudProviders]
  }

  /**
   * Explicitly adopt the latest revision for one configRef (or all observed configs when omitted).
   * Allows recovering from `AI_CONFIG_REVISION_CONFLICT` without changing stable model IDs or allowlists.
   */
  adoptLatestRevision(configRef?: string): void {
    if (configRef === undefined) {
      this.observed.clear()
      this.adoptedLegacyModels.clear()
      this.adoptedLegacyModels.add('*')
      return
    }
    this.observed.delete(configRef)
    this.observed.delete(this.model.id)
    for (const legacyModel of [...this.adoptedLegacyModels]) {
      if (legacyModel.startsWith(`config.${configRef}.`)) this.adoptedLegacyModels.delete(legacyModel)
    }
    // Mark configRef so legacy models referencing this configRef adopt the new revision on next call.
    this.adoptedLegacyModels.add(`config.${configRef}.*`)
  }

  /** Read the currently observed revision for a configRef, if captured. */
  getObservedRevision(configRef: string): ObservedRevision | undefined {
    return this.observed.get(configRef)
  }

  override providerInfo(provider: string) {
    if (provider === NIMI_LOCAL_PROVIDER_ID) {
      return { ...super.providerInfo(provider), name: 'Nimi Local', requestEnvelope: textEnvelope }
    }
    if (provider.startsWith(NIMI_CLOUD_PROVIDER_PREFIX)) {
      const connectorRef = provider.slice(NIMI_CLOUD_PROVIDER_PREFIX.length)
      const connector = this.cachedRoutes?.cloudConnectors.find(c => c.connectorRef === connectorRef)
      const name = connector ? connector.label : connectorRef
      return { ...super.providerInfo(provider), name, requestEnvelope: textEnvelope }
    }
    return { ...super.providerInfo(provider), requestEnvelope: textEnvelope }
  }

  private formatSavedBadge(choice: NimiModelChoice): LlmModelInfo['badge'] {
    const target = choice.targetLabel
    if (choice.routeKind === 'local') {
      const text = target ? `${target} · Local` : 'Local'
      return { text, tone: 'neutral' }
    }
    if (choice.routeKind === 'cloud') {
      const connector = choice.connectorLabel ?? choice.provider
      const text = target && connector
        ? `${target} · ${connector}`
        : target ?? connector
      if (text && text !== choice.name) return { text, tone: 'neutral' }
    }
    if (target && target !== choice.name) return { text: target, tone: 'neutral' }
    return undefined
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (this.routes) {
      const catalog = await this.refreshRoutes(undefined, false)
      if (!catalog) return []
      if (provider === this.model.provider) {
        if (catalog.configs.length === 0) return [this.model]
        return catalog.configs.map((choice) => {
          const parsed = parseNimiModelId(choice.id, this.model.id)
          const stableId = choice.configRef
            ? `config.${choice.configRef}`
            : parsed?.kind === 'named'
              ? `config.${parsed.configRef}`
              : choice.id
          const badge = this.formatSavedBadge(choice)
          const description = [choice.routeKind, choice.connectorLabel, choice.provider, choice.targetLabel]
            .filter(Boolean)
            .join(' ')
          return {
            provider,
            id: stableId,
            name: choice.name,
            ...(description ? { description } : {}),
            ...(badge ? { badge } : {}),
          }
        })
      }
      if (provider === NIMI_LOCAL_PROVIDER_ID) {
        if (catalog.local.available) {
          return [{
            provider,
            id: 'local',
            name: catalog.local.label ?? 'Local model',
            description: 'local on-device',
            badge: { text: { zh: '本机', en: 'Local' }, tone: 'neutral' },
          }]
        }
        return [{
          provider,
          id: NIMI_LOCAL_UNCONFIGURED_MODEL_ID,
          name: 'Local model',
          description: 'local on-device setup in nimi home',
          badge: { text: { zh: '未配置', en: 'Not set' }, tone: 'neutral' },
        }]
      }
      if (provider.startsWith(NIMI_CLOUD_PROVIDER_PREFIX)) {
        const connectorRef = provider.slice(NIMI_CLOUD_PROVIDER_PREFIX.length)
        const connector = catalog.cloudConnectors.find(c => c.connectorRef === connectorRef)
        if (!connector) return []
        return connector.targets.map(target => ({
          provider,
          id: target.targetKey,
          name: target.label,
          description: `cloud ${connector.label} ${connector.provider} ${target.providerModelId ?? ''}`.trim(),
          badge: target.matchedConfigName
            ? { text: target.matchedConfigName, tone: 'neutral' }
            : { text: connector.provider, tone: 'neutral' },
        }))
      }
      return []
    }

    if (provider !== this.model.provider) return []
    const choices = this.listChoices ? await this.listChoices() : []
    const display = (entry: LlmModelInfo, target?: string): LlmModelInfo => target && target !== entry.name
      ? { ...entry, description: target, badge: { text: target, tone: 'neutral' } }
      : entry
    return [
      display(this.model, choices.find(choice => choice.isDefault)?.targetLabel),
      ...choices.map((choice) => {
        const parsed = parseNimiModelId(choice.id, this.model.id)
        const stableId = choice.configRef
          ? `config.${choice.configRef}`
          : parsed?.kind === 'named'
            ? `config.${parsed.configRef}`
            : choice.id
        return display({ provider, id: stableId, name: choice.name }, choice.targetLabel)
      }),
    ]
  }

  override async commitModelSelection(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ readonly provider: string; readonly model: string }> {
    if (provider === this.model.provider) {
      const parsed = parseNimiModelId(model, this.model.id)
      if (parsed?.kind === 'named') {
        return { provider, model: `config.${parsed.configRef}` }
      }
      if (parsed?.kind === 'default' && this.cachedRoutes?.configs.length) {
        const defaultConfig = this.cachedRoutes.configs.find(c => c.isDefault) ?? this.cachedRoutes.configs[0]
        if (defaultConfig?.configRef) {
          return { provider, model: `config.${defaultConfig.configRef}` }
        }
      }
      return { provider, model }
    }
    if (!this.routes) {
      throw new LlmError('Select a model configured for this application in Nimi Home.', 'NO_ADAPTER')
    }
    if (provider === NIMI_LOCAL_PROVIDER_ID) {
      if (model === NIMI_LOCAL_UNCONFIGURED_MODEL_ID) {
        throw LlmError.fromFailure({
          code: 'NIMI_LOCAL_MODEL_NOT_CONFIGURED',
          message: 'Configure an on-device text model in Nimi Home first.',
        })
      }
      const ensured = await this.routes.ensureRouteConfig({ route: 'local' }, signal)
      this.cachedRoutesAt = 0
      this.routes.onCatalogChanged?.()
      return { provider: this.model.provider, model: `config.${ensured.configRef}` }
    }
    if (provider.startsWith(NIMI_CLOUD_PROVIDER_PREFIX)) {
      const connectorRef = provider.slice(NIMI_CLOUD_PROVIDER_PREFIX.length)
      const ensured = await this.routes.ensureRouteConfig({ route: 'cloud', connectorRef, targetKey: model }, signal)
      this.cachedRoutesAt = 0
      this.routes.onCatalogChanged?.()
      return { provider: this.model.provider, model: `config.${ensured.configRef}` }
    }
    throw new LlmError('Select a model configured for this application in Nimi Home.', 'NO_ADAPTER')
  }

  private async selection(provider: string, model: string, signal?: AbortSignal, enforceRevision = false) {
    if (provider === NIMI_LOCAL_PROVIDER_ID || provider.startsWith(NIMI_CLOUD_PROVIDER_PREFIX)) {
      throw new LlmError('Select or save this Nimi route as a named configuration before using it directly.', 'NO_ADAPTER')
    }
    const parsed = parseNimiModelId(model, this.model.id)
    if (provider !== this.model.provider || !parsed || (parsed.kind === 'named' && !this.readInfo)) {
      throw new LlmError('Select a model configured for this application in Nimi Home.', 'NO_ADAPTER')
    }
    const requestedRef = parsed.kind === 'named' ? parsed.configRef : undefined
    const info = await this.readInfo?.(signal, requestedRef)
    if (info?.ready === false) {
      throw LlmError.fromFailure({ code: 'AI_CONFIG_INVALID', message: 'Open Nimi settings and choose an available text model.' })
    }
    if (!info) return info

    const configKey = info.configuration?.configRef ?? requestedRef ?? this.model.id
    const currentConfig = info.configuration

    // Backward-compat legacy hashed model IDs (`config.<ref>.<sha256>`): detect hash drift unless explicitly adopted.
    if (parsed.kind === 'named' && parsed.legacyHash !== undefined) {
      const legacyAdopted = this.adoptedLegacyModels.has('*')
        || this.adoptedLegacyModels.has(model)
        || this.adoptedLegacyModels.has(`config.${parsed.configRef}.*`)
      const currentIdentity = info.revisionIdentity ?? (info.id?.startsWith(`config.${parsed.configRef}.`) ? info.id.slice(`config.${parsed.configRef}.`.length) : undefined)
      if (!legacyAdopted && currentIdentity !== undefined && currentIdentity !== parsed.legacyHash) {
        throw LlmError.fromFailure({
          code: 'AI_CONFIG_REVISION_CONFLICT',
          message: `This Nimi configuration changed${info.targetLabel ? ` (now "${info.targetLabel}")` : ''}. Adopt the updated configuration to continue.`,
          diagnostics: {
            reasonCode: 'AI_CONFIG_REVISION_CONFLICT',
            configRef: parsed.configRef,
            ...(currentConfig?.expectedRevision ? { latestRevision: currentConfig.expectedRevision } : {}),
            ...(info.targetLabel ? { targetLabel: info.targetLabel } : {}),
          },
        })
      }
    }

    if (currentConfig) {
      const prior = this.observed.get(configKey)
      if (enforceRevision && prior !== undefined && !revisionsMatch(prior, currentConfig, info.revisionIdentity)) {
        throw LlmError.fromFailure({
          code: 'AI_CONFIG_REVISION_CONFLICT',
          message: `This Nimi configuration changed${info.targetLabel ? ` (now "${info.targetLabel}")` : ''}. Adopt the updated configuration to continue.`,
          diagnostics: {
            reasonCode: 'AI_CONFIG_REVISION_CONFLICT',
            configRef: currentConfig.configRef,
            previousRevision: prior.expectedRevision,
            ...(currentConfig.expectedRevision ? { latestRevision: currentConfig.expectedRevision } : {}),
            ...(info.targetLabel ? { targetLabel: info.targetLabel } : {}),
          },
        })
      }
      if (prior === undefined) {
        this.observed.set(configKey, {
          configRef: currentConfig.configRef,
          expectedRevision: currentConfig.expectedRevision ?? '',
          ...(currentConfig.expectedLocalLoadoutRef ? { expectedLocalLoadoutRef: currentConfig.expectedLocalLoadoutRef } : {}),
          ...(currentConfig.expectedLocalLoadoutRevision
            ? { expectedLocalLoadoutRevision: currentConfig.expectedLocalLoadoutRevision }
            : {}),
          ...(info.revisionIdentity ? { revisionIdentity: info.revisionIdentity } : {}),
          ...(info.targetLabel ? { targetLabel: info.targetLabel } : {}),
        })
      }
    }
    return info
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (provider === NIMI_LOCAL_PROVIDER_ID) {
      const catalog = this.cachedRoutes ?? await this.refreshRoutes(signal, false)
      const local = catalog?.local
      return {
        provider,
        id: model,
        name: local?.available ? (local.label ?? 'Local model') : 'Local model',
        inputModalities: local?.configuredFeatures.includes('input.image') ? ['text', 'image'] : ['text'],
      }
    }
    if (provider.startsWith(NIMI_CLOUD_PROVIDER_PREFIX)) {
      const catalog = this.cachedRoutes ?? await this.refreshRoutes(signal, false)
      const connectorRef = provider.slice(NIMI_CLOUD_PROVIDER_PREFIX.length)
      const connector = catalog?.cloudConnectors.find(c => c.connectorRef === connectorRef)
      const target = connector?.targets.find(t => t.targetKey === model)
      if (!target) {
        throw new LlmError('Selected Nimi Cloud model is unavailable. Refresh models to try again.', 'NO_ADAPTER')
      }
      return {
        provider,
        id: model,
        name: target.label,
        inputModalities: target.supportedFeatures.includes('input.image') ? ['text', 'image'] : ['text'],
      }
    }
    const info = await this.selection(provider, model, signal, false)
    if (!info) return this.model
    const choices = reasoningChoices(info.reasoningInput)
    return {
      ...this.model,
      id: model,
      name: model === this.model.id ? this.model.name : info.name ?? model,
      inputModalities: info.imageInput ? ['text', 'image'] : ['text'],
      ...(choices.length ? { reasoning: { efforts: choices.map(({ id, name }) => ({ id, name })) } } : {}),
      ...(info.requestCapacityFloorTokens === undefined ? {} : { requestCapacityFloorTokens: info.requestCapacityFloorTokens }),
      ...(info.contextWindow === undefined ? {} : { context: { contextWindow: info.contextWindow } }),
    }
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const info = await this.selection(options.provider, options.model, options.signal, true)
    const effort = options.reasoningEffort
    const reasoning = effort === undefined ? undefined : reasoningChoices(info?.reasoningInput).find(choice => choice.id === effort)?.input
    if (effort !== undefined && !reasoning) throw new LlmError(`Reasoning effort "${effort}" is unavailable for this Nimi configuration.`, 'UNSUPPORTED_REASONING_EFFORT')
    if ((options.tools?.length ?? 0) > 64) throw LlmError.fromFailure({ code: 'NIMI_TOOL_LIMIT',
      message: 'Nimi admits up to 64 active tools per request. Reduce the active tool set.' })
    const imageInput = info?.imageInput ?? this.model.inputModalities?.includes('image')
    const input = await request(options, imageInput ? this.resolveImage : undefined, info?.streamCarriers ?? [])
    if (input.messages.length > textEnvelope.maxMessages) {
      throw new LlmError('The conversation exceeds the 128-message Nimi request limit.', CONTEXT_WINDOW_EXCEEDED_CODE)
    }
    const blocks = new Map<number, ContentBlock>()
    const continuity: { itemIndex: number; carrier: Continuity }[] = []
    const indices: number[] = []
    const turnInput = {
      ...input,
      ...(reasoning ? { reasoning } : {}),
      ...(info?.configuration ? { configuration: info.configuration } : {}),
    }
    for await (const event of this.streamTurn(turnInput, options.signal)) {
      switch (event.type) {
        case 'delta': {
          let block = blocks.get(event.itemIndex)
          if (block === undefined) {
            block = { type: 'text', text: '' }
            blocks.set(event.itemIndex, block)
            indices.push(event.itemIndex)
            yield { type: 'block-start', index: event.itemIndex, blockType: 'text' }
          }
          if (block.type !== 'text') throw new LlmError('Nimi text item conflicts with its earlier type.', 'MALFORMED_RESPONSE')
          block.text += event.text
          if (event.text) yield { type: 'text-delta', index: event.itemIndex, text: event.text }
          break
        }
        case 'reasoning-summary': {
          let block = blocks.get(event.itemIndex)
          if (block === undefined) {
            block = { type: 'reasoning', text: '' }
            blocks.set(event.itemIndex, block)
            indices.push(event.itemIndex)
            yield { type: 'block-start', index: event.itemIndex, blockType: 'reasoning' }
          }
          if (block.type !== 'reasoning') throw new LlmError('Nimi reasoning item conflicts with its earlier type.', 'MALFORMED_RESPONSE')
          block.text += event.text
          if (event.text) yield { type: 'reasoning-delta', index: event.itemIndex, text: event.text }
          break
        }
        case 'reasoning-continuity':
          continuity.push({ itemIndex: event.itemIndex, carrier: event.carrier })
          break
        case 'tool-call': {
          const { id, name, arguments: args } = event.toolCall
          const block = { type: 'tool-call' as const, id: ToolCallId(id), name, arguments: JSON.stringify(args) }
          yield { type: 'block-start', index: event.itemIndex, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: event.itemIndex, id: block.id, name, argumentsDelta: block.arguments }
          blocks.set(event.itemIndex, block)
          indices.push(event.itemIndex)
          break
        }
        case 'failed': {
          const failure = nimiFailure(event, 'NIMI_TEXT_TURN_FAILED')
          yield { type: 'finish', reason: { kind: 'error', failure } }
          return
        }
        case 'completed':
          if (event.finishReason === 'content-filter') {
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AI_CONTENT_FILTER_BLOCKED', message: 'Nimi reported content filtering.' } } }
            return
          }
          for (const [index, block] of blocks) yield { type: 'block-end', index, block }
          if (event.usage?.promptTokens !== undefined && event.usage.completionTokens !== undefined) {
            yield { type: 'usage', usage: {
              inputTokens: event.usage.promptTokens, outputTokens: event.usage.completionTokens,
              totalTokens: event.usage.promptTokens + event.usage.completionTokens,
            } }
          }
          yield {
            type: 'finish',
            reason: { kind: event.finishReason === 'length' ? 'max-tokens' : event.finishReason },
            replayState: { response: { continuity }, blocks: indices },
          }
          return
      }
    }
    throw new LlmError('Nimi ended the stream without a terminal result.', 'MALFORMED_RESPONSE')
  }
}

async function request(options: GenerateOptions, resolveImage: ResolveImage | undefined, streamCarriers: NimiModelInfo['streamCarriers']): Promise<NimiLocalAppTextTurnInput> {
  const messages: Message[] = []
  const calls = new Map<string, string>()
  const artifacts = new Map<ImageRef['attachmentId'], string>()
  const toImage = async (ref: ImageRef): Promise<Part> => {
    if (!resolveImage) throw new LlmError('The text route configured in Nimi Home does not admit images.', 'UNSUPPORTED_CONTENT')
    let artifactId = artifacts.get(ref.attachmentId)
    if (!artifactId) {
      artifactId = await resolveImage(ref, options.signal)
      artifacts.set(ref.attachmentId, artifactId)
    }
    return { type: 'artifact-ref', artifactId, mediaType: ref.mediaType, ...(ref.name ? { displayName: ref.name } : {}) }
  }
  if (options.system) messages.push({ role: 'system', text: options.system })
  for (const message of projectOffloadedImages(options.messages, ref => offloadedImageText(ref))) {
    if (message.role === 'assistant') {
      const items: Item[] = []
      const sameRoute = message.source.provider === options.provider && message.source.model === options.model
      for (const block of message.content) {
        if (block.type === 'text') items.push({ type: 'output', output: { ...block } })
        else if (block.type === 'reasoning') {
          // An imported thought can appear in DSH history. Only this route produced its own replay items.
          if (sameRoute) items.push({ type: 'output', output: { type: 'reasoning-summary', text: block.text } })
        }
        else if (block.type === 'tool-call') {
          calls.set(block.id, block.name)
          const args: unknown = JSON.parse(block.arguments)
          if (typeof args !== 'object' || args === null || Array.isArray(args)) {
            throw new LlmError('Historical tool arguments must be a JSON object.', 'MALFORMED_RESPONSE')
          }
          items.push({ type: 'output', output: { type: 'tool-call', toolCall: { id: block.id, name: block.name, arguments: args as NimiJsonObject } } })
        } else {
          throw new Error(`Nimi DSH model path cannot represent assistant block ${block.type}.`)
        }
      }
      if (sameRoute) {
        const replay = message.source.replayState as {
          response?: { continuity?: { carrier: Continuity; itemIndex: number }[] }
          blocks?: number[]
        } | undefined
        if (replay?.blocks?.length === items.length && replay.response?.continuity) {
          const blocks = replay.blocks
          const ordered = items.map((item, i) => ({ item, index: blocks[i] ?? i }))
          for (const { carrier, itemIndex } of replay.response.continuity) {
            if (!streamCarriers.some(format => format.kind === carrier.kind && format.version === carrier.version)) continue
            ordered.push({ index: itemIndex, item: { type: 'output', output: { type: 'reasoning-continuity', carrier } } })
          }
          items.splice(0, items.length, ...ordered.sort((a, b) => a.index - b.index).map(entry => entry.item))
        }
      }
      if (items.length) messages.push({ role: 'assistant', text: '', turnItems: items })
      continue
    }
    if (message.role === 'user' && message.content.some(block => block.type === 'image')) {
      const parts: Part[] = []
      for (const block of message.content) {
        if (block.type === 'image') parts.push(await toImage(block.attachment))
        else if (block.type === 'text' && block.text) parts.push({ type: 'text', text: block.text })
        else if (block.type !== 'text') throw new LlmError(`Unsupported image message block: ${block.type}.`, 'UNSUPPORTED_CONTENT')
      }
      messages.push({ role: 'user', text: '', parts })
      continue
    }
    const text = message.content.flatMap((block) => {
      if (block.type === 'text') return [block.text]
      if (message.role === 'developer' && (block.type === 'tool-addition' || block.type === 'tool-removal')) return []
      if (message.role === 'tool' && block.type === 'image') return []
      throw new Error(`Nimi DSH model path cannot represent ${message.role} block ${block.type}.`)
    }).join('\n')
    if (message.role === 'tool') {
      const toolName = calls.get(message.toolCallId)
      if (toolName === undefined) throw new LlmError('Tool result has no preceding call.', 'MALFORMED_RESPONSE')
      messages.push({ role: 'assistant', text: '', turnItems: [{
        type: 'tool-result', toolResult: { toolCallId: message.toolCallId, toolName, result: text, isError: message.isError ?? false },
      }] })
      const images = message.content.filter(block => block.type === 'image')
      if (images.length) {
        const parts: Part[] = [{ type: 'text', text: `Image returned by tool ${toolName} (call ${message.toolCallId}).` }]
        for (const image of images) parts.push(await toImage(image.attachment))
        messages.push({ role: 'user', text: '', parts })
      }
    } else if (text.trim()) {
      messages.push({ role: message.role === 'developer' ? 'system' : message.role, text })
    }
  }
  return {
    messages,
    ...(options.tools === undefined ? {} : { tools: options.tools.map(tool => ({
      type: 'function', name: tool.name, description: tool.description, inputSchema: tool.parameters as NimiJsonObject,
    })) }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
  }
}
