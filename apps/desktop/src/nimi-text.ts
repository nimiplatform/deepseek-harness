/** Serve text turns, image uploads, audio transcription, and Cloud/Local route selection over one Desktop Host's private IPC. */
import { createHash } from 'node:crypto'
import type { NimiElectronAppBusinessServices } from '@nimiplatform/kit/shell/electron/main'
import {
  createNimiCloudAIConfigCapabilityIntent,
  createNimiLocalAIConfigCapabilityIntent,
  runtimeAIConfigStructToJson,
} from '@nimiplatform/sdk/ai'
import type { ChildProcess } from 'node:child_process'
import type { NimiLocalAppAIConsumptionClient, NimiLocalAppTextTurnInput } from '@nimiplatform/sdk/app'
import { extractNimiErrorFields } from '@nimiplatform/sdk/types'

type ConfigService = NimiElectronAppBusinessServices['aiConfig']
type Snapshot = Awaited<ReturnType<ConfigService['get']>>

export type NimiRouteKind = 'cloud' | 'local' | 'unset'

export interface NimiSavedConfigChoice {
  readonly id: string
  readonly configRef: string
  readonly name: string
  readonly isDefault: boolean
  readonly revision: string
  readonly routeKind: NimiRouteKind
  readonly connectorRef?: string
  readonly connectorLabel?: string
  readonly provider?: string
  readonly targetLabel?: string
  readonly targetKey?: string
  readonly localLoadoutRevision?: string
}

export interface NimiLocalRouteCatalogEntry {
  readonly available: boolean
  readonly state: 'ready' | 'missing' | 'blocked'
  readonly label?: string
  readonly loadoutRef?: string
  readonly reasons: readonly string[]
  readonly configuredFeatures: readonly string[]
  readonly matchedConfigRef?: string
}

export interface NimiCloudTargetCatalogEntry {
  readonly targetKey: string
  readonly label: string
  readonly providerModelId?: string
  readonly supportedFeatures: readonly string[]
  readonly matchedConfigRef?: string
  readonly matchedConfigName?: string
}

export interface NimiCloudConnectorCatalogGroup {
  readonly connectorRef: string
  readonly label: string
  readonly provider: string
  readonly targets: readonly NimiCloudTargetCatalogEntry[]
}

export interface NimiRouteCatalog {
  readonly configs: readonly NimiSavedConfigChoice[]
  readonly local: NimiLocalRouteCatalogEntry
  readonly cloudConnectors: readonly NimiCloudConnectorCatalogGroup[]
}

export type NimiEnsureRouteRequest =
  | { readonly route: 'local' }
  | { readonly route: 'cloud'; readonly connectorRef: string; readonly targetKey: string }

const MAX_IMAGE_BYTES = 32 * 1024 * 1024
/**
 * DSH agent turns require streaming tool-use support.
 * When Runtime projects canonical `textBehaviors` on `text.generate` Cloud targets,
 * admit only targets with configured streaming tool-use; when absent (older Runtime),
 * fall back to allowing ready targets.
 */
function supportsStreamingToolUse(target: {
  readonly textBehaviors?: readonly {
    readonly kind?: string
    readonly configurationState?: string
    readonly configuredToolUse?: { readonly supportsStream?: boolean } | null
  }[]
}): boolean {
  if (!Array.isArray(target.textBehaviors) || target.textBehaviors.length === 0) return true
  const toolUse = target.textBehaviors.find(b => b.kind === 'tool-use')
  return toolUse?.configurationState === 'configured' && toolUse.configuredToolUse?.supportsStream === true
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const ALLOWED_AUDIO_MIME_TYPES = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/flac',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
])

function isProtobufStruct(value: unknown): value is { fields: Record<string, unknown> } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'fields' in value && typeof (value as { fields?: unknown }).fields === 'object'
    && (value as { fields?: unknown }).fields !== null
}

function unwrapTargetJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  if (isProtobufStruct(value)) {
    return runtimeAIConfigStructToJson(value as Parameters<typeof runtimeAIConfigStructToJson>[0]) as Record<string, unknown>
  }
  return value as Record<string, unknown>
}

export function canonicalTargetKey(raw: unknown): string {
  const target = unwrapTargetJson(raw)
  if (!target) return ''
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(target).sort()) {
    sorted[key] = target[key]
  }
  try { return JSON.stringify(sorted) } catch { return '' }
}

function targetObjectsMatch(leftRaw: unknown, rightRaw: unknown): boolean {
  const left = unwrapTargetJson(leftRaw)
  const right = unwrapTargetJson(rightRaw)
  if (!left || !right) return false
  if (canonicalTargetKey(left) === canonicalTargetKey(right)) return true
  const leftCatalog = typeof left.remoteModelCatalogId === 'string' ? left.remoteModelCatalogId : ''
  const rightCatalog = typeof right.remoteModelCatalogId === 'string' ? right.remoteModelCatalogId : ''
  if (leftCatalog && rightCatalog) return leftCatalog === rightCatalog
  const leftModel = typeof left.providerModelId === 'string' ? left.providerModelId : ''
  const rightModel = typeof right.providerModelId === 'string' ? right.providerModelId : ''
  return Boolean(leftModel && rightModel && leftModel === rightModel)
}

function uniqueRecordName(baseName: string, existingNames: ReadonlySet<string>): string {
  const sanitized = baseName.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 118) || 'Nimi Model'
  if (!existingNames.has(sanitized)) return sanitized
  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${sanitized} (${suffix})`.slice(0, 128)
    if (!existingNames.has(candidate)) return candidate
  }
  return `${sanitized.slice(0, 110)}-${Date.now().toString(36)}`
}

function modelInfo(snapshot: Snapshot) {
  const record = snapshot.record
  if (!record) throw new Error('Configure a text model for Nimi DSH in Home.')
  const selection = snapshot.effectiveSelections.find(item => item.capabilityContract === 'text.generate')
  const intent = snapshot.config?.capabilities?.find(item => item.capabilityContract === 'text.generate')
  const resource = selection?.resource
  const local = resource?.oneofKind === 'local' ? resource.local : undefined
  const cloud = resource?.oneofKind === 'cloud' ? resource.cloud : undefined
  const routeKind: NimiRouteKind = local || intent?.route.oneofKind === 'local'
    ? 'local'
    : cloud || intent?.route.oneofKind === 'cloud'
      ? 'cloud'
      : 'unset'
  const intentCloudTarget = intent?.route.oneofKind === 'cloud' ? unwrapTargetJson(intent.route.cloud.providerModelTarget) : undefined
  const effectiveCloudTarget = cloud?.target.providerModelTarget ? unwrapTargetJson(cloud.target.providerModelTarget) : undefined
  const normalizedTarget = intentCloudTarget ?? effectiveCloudTarget
  const targetKey = routeKind === 'cloud' ? canonicalTargetKey(normalizedTarget) : undefined
  const connectorRef = cloud?.connector.connectorRef ?? (intent?.route.oneofKind === 'cloud' ? intent.route.cloud.connectorRef : undefined)
  const connectorLabel = cloud?.connector.label
  const provider = cloud?.connector.provider
    ?? (typeof normalizedTarget?.provider === 'string' ? normalizedTarget.provider : undefined)
  const configuration = {
    configRef: record.configRef,
    expectedRevision: record.revision,
    ...(local && selection?.localLoadoutRevision ? {
      expectedLocalLoadoutRef: local.loadoutRef,
      expectedLocalLoadoutRevision: selection.localLoadoutRevision,
    } : {}),
  }
  const target = local?.implementation.implementationId ?? cloud?.target.providerModelTarget
  const revisionIdentity = createHash('sha256').update(JSON.stringify([configuration, target])).digest('hex')
  return {
    /** Stable configRef-keyed model ID (never embeds revision/sha256). */
    id: `config.${record.configRef}`,
    configRef: record.configRef,
    revisionIdentity,
    name: record.name,
    routeKind,
    ...(connectorRef ? { connectorRef } : {}),
    ...(connectorLabel ? { connectorLabel } : {}),
    ...(provider ? { provider } : {}),
    ...(targetKey ? { targetKey } : {}),
    targetLabel: cloud?.target.label ?? local?.label,
    ready: Boolean(resource && selection?.state === 'ready'),
    configuration,
    ...(selection?.reasoningInput ? { reasoningInput: selection.reasoningInput } : {}),
    ...(selection?.requestCapacityFloorTokens === undefined ? {} : { requestCapacityFloorTokens: selection.requestCapacityFloorTokens }),
    imageInput: (local?.configuredFeatures ?? cloud?.target.supportedFeatures ?? []).includes('input.image'),
    streamCarriers: (selection?.textReplay?.acceptedCarriers ?? [])
      .filter(carrier => carrier.executionModes.includes('stream')).map(({ kind, version }) => ({ kind, version })),
    ...(selection?.contextWindowTokens === undefined ? {} : { contextWindow: selection.contextWindowTokens }),
  }
}

export function createNimiModelCatalog(service: ConfigService) {
  async function readAllRecordSnapshots() {
    const directory = await service.get({ includeRecords: true })
    const records = directory.records ?? (directory.record ? [directory.record] : [])
    const snapshots = await Promise.all(records.map(async (record) => {
      const snapshot = record.configRef === directory.record?.configRef
        ? directory
        : await service.get({ configRef: record.configRef })
      return { record, snapshot }
    }))
    // Keep default record first, then preserve stable name order.
    snapshots.sort((a, b) => {
      if (a.record.isDefault !== b.record.isDefault) return a.record.isDefault ? -1 : 1
      return a.record.name.localeCompare(b.record.name)
    })
    return { directory, snapshots }
  }

  return {
    async list() {
      const { snapshots } = await readAllRecordSnapshots()
      const choices: NimiSavedConfigChoice[] = []
      for (const { record, snapshot } of snapshots) {
        const model = modelInfo(snapshot)
        if (model.ready) {
          choices.push({
            id: model.id,
            configRef: record.configRef,
            name: model.name,
            isDefault: record.isDefault,
            revision: record.revision,
            routeKind: model.routeKind,
            ...(model.connectorRef ? { connectorRef: model.connectorRef } : {}),
            ...(model.connectorLabel ? { connectorLabel: model.connectorLabel } : {}),
            ...(model.provider ? { provider: model.provider } : {}),
            ...(model.targetKey ? { targetKey: model.targetKey } : {}),
            ...(model.configuration.expectedLocalLoadoutRevision
              ? { localLoadoutRevision: model.configuration.expectedLocalLoadoutRevision }
              : {}),
            ...(model.targetLabel ? { targetLabel: model.targetLabel } : {}),
          })
        }
      }
      return choices
    },
    async listRoutes(): Promise<NimiRouteCatalog> {
      const [{ snapshots }, localResult, connectorsResult] = await Promise.all([
        readAllRecordSnapshots(),
        typeof service.listOptions === 'function'
          ? service.listOptions({ kind: 'local-loadouts', capabilityContract: 'text.generate' }).catch(() => ({ kind: 'local-loadouts' as const, options: [], truncated: false }))
          : Promise.resolve({ kind: 'local-loadouts' as const, options: [], truncated: false }),
        typeof service.listOptions === 'function'
          ? service.listOptions({ kind: 'cloud-connectors', capabilityContract: 'text.generate' }).catch(() => ({ kind: 'cloud-connectors' as const, options: [], truncated: false }))
          : Promise.resolve({ kind: 'cloud-connectors' as const, options: [], truncated: false }),
      ])

      const configs: NimiSavedConfigChoice[] = []
      const recordMatches: {
        configRef: string
        name: string
        isDefault: boolean
        routeKind: NimiRouteKind
        connectorRef?: string
        targetObj?: Record<string, unknown>
      }[] = []

      for (const { record, snapshot } of snapshots) {
        const info = modelInfo(snapshot)
        const intent = snapshot.config?.capabilities?.find(c => c.capabilityContract === 'text.generate')
        const intentTarget = intent?.route.oneofKind === 'cloud'
          ? unwrapTargetJson(intent.route.cloud.providerModelTarget)
          : undefined
        recordMatches.push({
          configRef: record.configRef,
          name: record.name,
          isDefault: record.isDefault,
          routeKind: info.routeKind,
          ...(info.connectorRef ? { connectorRef: info.connectorRef } : {}),
          ...(intentTarget ? { targetObj: intentTarget } : {}),
        })
        if (info.ready) {
          configs.push({
            id: info.id,
            configRef: record.configRef,
            name: info.name,
            isDefault: record.isDefault,
            revision: record.revision,
            routeKind: info.routeKind,
            ...(info.connectorRef ? { connectorRef: info.connectorRef } : {}),
            ...(info.connectorLabel ? { connectorLabel: info.connectorLabel } : {}),
            ...(info.provider ? { provider: info.provider } : {}),
            ...(info.targetKey ? { targetKey: info.targetKey } : {}),
            ...(info.configuration.expectedLocalLoadoutRevision
              ? { localLoadoutRevision: info.configuration.expectedLocalLoadoutRevision }
              : {}),
            ...(info.targetLabel ? { targetLabel: info.targetLabel } : {}),
          })
        }
      }

      const localOption = localResult.kind === 'local-loadouts' ? localResult.options[0] : undefined
      const matchedLocalConfig = recordMatches.find(r => r.routeKind === 'local')
      const local: NimiLocalRouteCatalogEntry = {
        available: Boolean(localOption && localOption.state === 'ready'),
        state: localOption ? (localOption.state === 'ready' ? 'ready' : 'blocked') : 'missing',
        ...(localOption?.label ? { label: localOption.label } : {}),
        ...(localOption?.loadoutRef ? { loadoutRef: localOption.loadoutRef } : {}),
        reasons: localOption?.reasons ?? [],
        configuredFeatures: localOption?.configuredFeatures ?? [],
        ...(matchedLocalConfig ? { matchedConfigRef: matchedLocalConfig.configRef } : {}),
      }

      const readyConnectors = connectorsResult.kind === 'cloud-connectors'
        ? connectorsResult.options.filter(c => c.state === 'ready')
        : []

      const cloudConnectors = (await Promise.all(readyConnectors.map(async (connector) => {
        const targetsRes = await service.listOptions({
          kind: 'cloud-targets',
          capabilityContract: 'text.generate',
          connectorRef: connector.connectorRef,
        }).catch(() => ({ kind: 'cloud-targets' as const, options: [], truncated: false }))
        const readyTargets = targetsRes.kind === 'cloud-targets'
          ? targetsRes.options.filter(t => t.state === 'ready' && supportsStreamingToolUse(t))
          : []
        const targets: NimiCloudTargetCatalogEntry[] = readyTargets.map((target) => {
          const targetObj = unwrapTargetJson(target.providerModelTarget) ?? {}
          const key = canonicalTargetKey(targetObj)
          const providerModelId = typeof targetObj.providerModelId === 'string' ? targetObj.providerModelId : undefined
          const matched = recordMatches.find(r =>
            r.routeKind === 'cloud'
            && r.connectorRef === connector.connectorRef
            && targetObjectsMatch(r.targetObj, targetObj))
          return {
            targetKey: key,
            label: target.label,
            ...(providerModelId ? { providerModelId } : {}),
            supportedFeatures: target.supportedFeatures ?? [],
            ...(matched ? { matchedConfigRef: matched.configRef, matchedConfigName: matched.name } : {}),
          }
        })
        return {
          connectorRef: connector.connectorRef,
          label: connector.label,
          provider: connector.provider,
          targets,
        } satisfies NimiCloudConnectorCatalogGroup
      }))).filter(group => group.targets.length > 0)

      return { configs, local, cloudConnectors }
    },
    async ensureRouteConfig(request: NimiEnsureRouteRequest) {
      const findExisting = async () => {
        const { directory, snapshots } = await readAllRecordSnapshots()
        if (request.route === 'local') {
          const matched = snapshots.find(({ snapshot }) =>
            snapshot.config?.capabilities?.some(c => c.capabilityContract === 'text.generate' && c.route.oneofKind === 'local'))
          return { directory, snapshots, matched }
        }
        const matched = snapshots.find(({ snapshot }) => {
          const intent = snapshot.config?.capabilities?.find(c => c.capabilityContract === 'text.generate')
          if (!intent || intent.route.oneofKind !== 'cloud') return false
          return intent.route.cloud.connectorRef === request.connectorRef
            && canonicalTargetKey(intent.route.cloud.providerModelTarget) === request.targetKey
        })
        return { directory, snapshots, matched }
      }

      const initial = await findExisting()
      if (initial.matched) {
        const info = modelInfo(initial.matched.snapshot)
        if (info.ready) {
          return {
            configRef: initial.matched.record.configRef,
            name: initial.matched.record.name,
            created: false,
            modelInfo: info,
          }
        }
      }

      const defaultSnapshot = initial.snapshots.find(s => s.record.isDefault)?.snapshot ?? initial.directory
      const preservedCapabilities = (defaultSnapshot.config?.capabilities ?? [])
        .filter(c => c.capabilityContract !== 'text.generate')
      const existingNames = new Set(initial.snapshots.map(s => s.record.name))

      let textIntent: ReturnType<typeof createNimiLocalAIConfigCapabilityIntent>
        | ReturnType<typeof createNimiCloudAIConfigCapabilityIntent>
      let recordName: string

      if (request.route === 'local') {
        const localRes = await service.listOptions({ kind: 'local-loadouts', capabilityContract: 'text.generate' })
        const localOption = localRes.kind === 'local-loadouts' ? localRes.options[0] : undefined
        if (!localOption || localOption.state !== 'ready') {
          throw Object.assign(
            new Error('No ready on-device text model is configured in Nimi Home. Configure a local model in Nimi Home first.'),
            { reasonCode: 'NIMI_LOCAL_MODEL_NOT_CONFIGURED', actionHint: 'open_nimi_home_ai_models' },
          )
        }
        textIntent = createNimiLocalAIConfigCapabilityIntent({
          capabilityContract: 'text.generate',
          requiredFeatures: [],
        })
        recordName = uniqueRecordName(localOption.label ? `Local · ${localOption.label}` : 'Local', existingNames)
      } else {
        const connectorsRes = await service.listOptions({ kind: 'cloud-connectors', capabilityContract: 'text.generate' })
        const connector = connectorsRes.kind === 'cloud-connectors'
          ? connectorsRes.options.find(c => c.connectorRef === request.connectorRef && c.state === 'ready')
          : undefined
        if (!connector) {
          throw Object.assign(
            new Error('Selected Nimi Cloud connector is unavailable. Refresh models or check Nimi Home.'),
            { reasonCode: 'NIMI_CLOUD_CONNECTOR_UNAVAILABLE', actionHint: 'check_nimi_home' },
          )
        }
        const targetsRes = await service.listOptions({
          kind: 'cloud-targets',
          capabilityContract: 'text.generate',
          connectorRef: connector.connectorRef,
        })
        const target = targetsRes.kind === 'cloud-targets'
          ? targetsRes.options.find(t => t.state === 'ready' && canonicalTargetKey(t.providerModelTarget) === request.targetKey)
          : undefined
        if (!target) {
          throw Object.assign(
            new Error('Selected Nimi Cloud model is no longer available. Refresh models and choose another target.'),
            { reasonCode: 'NIMI_CLOUD_TARGET_UNAVAILABLE', actionHint: 'refresh_models' },
          )
        }
        textIntent = createNimiCloudAIConfigCapabilityIntent({
          capabilityContract: 'text.generate',
          connectorRef: connector.connectorRef,
          requiredFeatures: [],
          implementation: target.implementation as never,
          providerModelTarget: unwrapTargetJson(target.providerModelTarget) as never,
        })
        recordName = uniqueRecordName(`${connector.label} / ${target.label}`, existingNames)
      }

      const overwriteRes = await service.overwrite({
        record: { action: 'create', name: recordName },
        expectedRevision: '0',
        capabilities: [...preservedCapabilities, textIntent],
      })
      if (overwriteRes.outcome !== 'committed' || !overwriteRes.record) {
        // Handle race where an identical route was concurrently created.
        const retry = await findExisting()
        if (retry.matched) {
          const info = modelInfo(retry.matched.snapshot)
          return {
            configRef: retry.matched.record.configRef,
            name: retry.matched.record.name,
            created: false,
            modelInfo: info,
          }
        }
        throw Object.assign(
          new Error('Could not save this Nimi model route (maximum 64 named configurations or concurrent update). Manage saved configurations in Nimi Settings.'),
          { reasonCode: 'AI_CONFIG_CREATE_FAILED', actionHint: 'manage_nimi_model_configs' },
        )
      }
      const createdSnapshot = await service.get({ configRef: overwriteRes.record.configRef })
      return {
        configRef: overwriteRes.record.configRef,
        name: overwriteRes.record.name,
        created: true,
        modelInfo: modelInfo(createdSnapshot),
      }
    },
    async get(configRef?: string) {
      return modelInfo(await service.get(configRef ? { configRef } : { includeRecords: true }))
    },
  }
}

async function runAudioTranscription(
  scenarioJobs: NimiLocalAppAIConsumptionClient['scenarioJobs'],
  input: {
    readonly bytes: Uint8Array
    readonly mimeType: string
    readonly language: string
    readonly prompt: string
    readonly timestamps?: boolean
    readonly configRef?: string
  },
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const submitted = await scenarioJobs.submit({
    type: 'speech-transcribe',
    mimeType: input.mimeType,
    language: input.language,
    prompt: input.prompt,
    responseFormat: '',
    ...(input.timestamps === undefined ? {} : { timestamps: input.timestamps }),
    audioSource: { type: 'bytes', bytes: input.bytes },
  }, input.configRef ? { configRef: input.configRef } : undefined)
  let job = submitted.job
  const isTerminal = (status: string) =>
    status === 'completed' || status === 'failed' || status === 'canceled' || status === 'timeout'

  if (!isTerminal(job.status)) {
    const subscription = await scenarioJobs.subscribe(job.jobId)
    const onAbort = () => {
      void subscription.cancel().catch(() => undefined)
      void scenarioJobs.cancel(job.jobId, 'caller aborted').catch(() => undefined)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      for await (const event of subscription) {
        job = event.job
        if (isTerminal(job.status)) break
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      await subscription.cancel().catch(() => undefined)
    }
    if (!isTerminal(job.status)) {
      const latest = await scenarioJobs.get(job.jobId)
      job = latest.job
    }
  }

  if (job.status !== 'completed') {
    const reasonCode = job.reasonCode || (job.status === 'canceled' ? 'AI_JOB_CANCELED' : 'AI_TRANSCRIPTION_FAILED')
    const message = job.reasonDetail || `Audio transcription ${job.status}.`
    throw Object.assign(new Error(message), { reasonCode, traceId: job.traceId })
  }

  const text = job.transcriptionText || job.transcription?.text || ''
  return {
    jobId: job.jobId,
    text,
    language: job.transcription?.language || input.language || undefined,
    ...(job.transcription?.words?.length ? { words: job.transcription.words } : {}),
  }
}

export function serveNimiText(
  child: ChildProcess,
  ai: Pick<NimiLocalAppAIConsumptionClient, 'text' | 'artifacts'> & Partial<Pick<NimiLocalAppAIConsumptionClient, 'scenarioJobs'>>,
  models?: ReturnType<typeof createNimiModelCatalog>,
) {
  const { text, artifacts, scenarioJobs } = ai
  type Stream = Awaited<ReturnType<typeof text.streamTurn>>
  const active = new Map<string, {
    opened: Promise<Stream>
    iterator?: ReturnType<Stream[typeof Symbol.asyncIterator]>
    reading: boolean
  }>()
  const transcriptionAborts = new Map<string, AbortController>()
  let closed = false
  const close = (id: string) => {
    const entry = active.get(id)
    active.delete(id)
    if (entry) void entry.opened.then(stream => stream.cancel()).catch(() => undefined)
    const abort = transcriptionAborts.get(id)
    if (abort) {
      transcriptionAborts.delete(id)
      abort.abort()
    }
  }
  function dispose(): void {
    closed = true
    for (const id of [...active.keys()]) close(id)
    for (const [id, abort] of [...transcriptionAborts.entries()]) {
      transcriptionAborts.delete(id)
      abort.abort()
    }
  }
  child.once('disconnect', dispose)
  const sendFailure = (id: string, reasonCode: string) => {
    if (child.connected && !closed) child.send({
      type: 'nimi-text-reply', id, error: { reasonCode, actionHint: 'restart_the_app_request' },
    }, () => undefined)
  }
  const accepts = (message: unknown): message is { type: 'nimi-text'; id: string; operation: unknown; input?: NimiLocalAppTextTurnInput } =>
    typeof message === 'object' && message !== null && 'type' in message && message.type === 'nimi-text'
    && 'id' in message && typeof message.id === 'string' && /^[0-9a-f-]{36}$/u.test(message.id) && 'operation' in message

  function receive(message: unknown): boolean {
    if (!accepts(message)) return false
    const { id, operation, input } = message
    if (closed || !child.connected) return true
    const reply = (result: object) => {
      if (child.connected && !closed) child.send({ type: 'nimi-text-reply', id, ...result }, () => undefined)
    }
    if (operation === 'model-list' && models) {
      void models.list().then(choices => reply({ choices }), error => reply({ error: extractNimiErrorFields(error) }))
      return true
    }
    if (operation === 'route-catalog' && models) {
      void models.listRoutes().then(routeCatalog => reply({ routeCatalog }), error => reply({ error: extractNimiErrorFields(error) }))
      return true
    }
    if (operation === 'ensure-route-config' && models) {
      const route = 'route' in message ? message.route : undefined
      if (route === 'local') {
        void models.ensureRouteConfig({ route: 'local' }).then(
          ensured => reply({ ensured }),
          error => reply({ error: extractNimiErrorFields(error) }),
        )
        return true
      }
      if (route === 'cloud') {
        const connectorRef = 'connectorRef' in message ? message.connectorRef : undefined
        const targetKey = 'targetKey' in message ? message.targetKey : undefined
        if (typeof connectorRef !== 'string' || !connectorRef.trim() || connectorRef.length > 256
          || typeof targetKey !== 'string' || !targetKey.trim() || targetKey.length > 4096) {
          sendFailure(id, 'NIMI_ROUTE_SELECTION_INVALID')
          return true
        }
        void models.ensureRouteConfig({ route: 'cloud', connectorRef: connectorRef.trim(), targetKey: targetKey.trim() }).then(
          ensured => reply({ ensured }),
          error => reply({ error: extractNimiErrorFields(error) }),
        )
        return true
      }
      sendFailure(id, 'NIMI_ROUTE_SELECTION_INVALID')
      return true
    }
    if (operation === 'model-info' && models) {
      const ref = 'configRef' in message ? message.configRef : undefined
      if (ref !== undefined && (typeof ref !== 'string' || !/^(main|[0-9a-f]{32})$/.test(ref))) {
        sendFailure(id, 'NIMI_CONFIGURATION_REFERENCE_INVALID')
        return true
      }
      void models.get(ref).then(info => reply({ modelInfo: info }), error => reply({ error: extractNimiErrorFields(error) }))
      return true
    }
    if (operation === 'upload-image') {
      const data = 'data' in message ? message.data : undefined
      const mimeType = 'mimeType' in message ? message.mimeType : undefined
      if (typeof data !== 'string' || !data || data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)
        || (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp' && mimeType !== 'image/gif')) {
        reply({ error: { reasonCode: 'NIMI_IMAGE_INPUT_INVALID' } })
        return true
      }
      void artifacts.upload({ bytes: Buffer.from(data, 'base64'), mimeType }).then(
        result => reply({ artifactId: result.artifactId }),
        error => reply({ error: extractNimiErrorFields(error) }),
      )
      return true
    }
    if (operation === 'transcribe-audio') {
      if (!scenarioJobs) {
        reply({ error: { reasonCode: 'NIMI_AUDIO_TRANSCRIBE_UNAVAILABLE', message: 'Audio transcription is unavailable in this Nimi runtime session.' } })
        return true
      }
      const data = 'data' in message ? message.data : undefined
      const mimeType = 'mimeType' in message ? message.mimeType : undefined
      const language = 'language' in message && typeof message.language === 'string' ? message.language : ''
      const prompt = 'prompt' in message && typeof message.prompt === 'string' ? message.prompt : ''
      const timestamps = 'timestamps' in message && typeof message.timestamps === 'boolean' ? message.timestamps : undefined
      const rawConfigRef = 'configRef' in message ? message.configRef : undefined
      if (rawConfigRef !== undefined && (typeof rawConfigRef !== 'string' || !/^(main|[0-9a-f]{32})$/.test(rawConfigRef))) {
        reply({ error: { reasonCode: 'NIMI_CONFIGURATION_REFERENCE_INVALID', message: 'Invalid Nimi configuration reference.' } })
        return true
      }
      if (typeof data !== 'string' || !data || data.length > 4 * Math.ceil(MAX_AUDIO_BYTES / 3)
        || typeof mimeType !== 'string' || !ALLOWED_AUDIO_MIME_TYPES.has(mimeType.toLowerCase())) {
        reply({ error: { reasonCode: 'NIMI_AUDIO_INPUT_INVALID', message: 'Unsupported or oversized audio input (max 25 MiB).' } })
        return true
      }
      const bytes = Buffer.from(data, 'base64')
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) {
        reply({ error: { reasonCode: 'NIMI_AUDIO_INPUT_INVALID', message: 'Audio input must be between 1 byte and 25 MiB.' } })
        return true
      }
      const controller = new AbortController()
      transcriptionAborts.set(id, controller)
      void runAudioTranscription(scenarioJobs, {
        bytes,
        mimeType: mimeType.toLowerCase(),
        language,
        prompt,
        ...(timestamps === undefined ? {} : { timestamps }),
        ...(rawConfigRef ? { configRef: rawConfigRef } : {}),
      }, controller.signal).then(
        (transcription) => {
          transcriptionAborts.delete(id)
          reply({ transcription })
        },
        (error) => {
          transcriptionAborts.delete(id)
          reply({ error: extractNimiErrorFields(error) })
        },
      )
      return true
    }
    if (operation === 'close') { close(id); return true }
    const send = (replyPayload: object) => {
      if (child.connected && !closed && active.has(id)) child.send({ type: 'nimi-text-reply', id, ...replyPayload }, (error) => {
        if (error) close(id)
      })
    }
    const fail = (error: unknown) => {
      send({ error: extractNimiErrorFields(error) })
      close(id)
    }
    if (operation === 'open' && !active.has(id) && input !== undefined) {
      if (active.size >= 8) {
        sendFailure(id, 'NIMI_TEXT_CAPACITY_EXCEEDED')
        return true
      }
      // Kit/SDK validate the bounded public input at the protected call.
      const opened = Promise.resolve().then(() => text.streamTurn(input))
      active.set(id, { opened, reading: false })
      void opened.then(() => send({ opened: true }), fail)
    } else if (operation === 'next') {
      const entry = active.get(id)
      if (entry && !entry.reading) {
        entry.reading = true
        void (async () => {
          const stream = await entry.opened
          entry.iterator ??= stream[Symbol.asyncIterator]()
          const event = await entry.iterator.next()
          entry.reading = false
          if (event.done) { send({ done: true }); active.delete(id) }
          else send({ event: event.value })
        })().catch(fail)
      } else {
        sendFailure(id, 'NIMI_TEXT_STREAM_INVALID')
      }
    } else {
      sendFailure(id, 'NIMI_TEXT_REQUEST_INVALID')
    }
    return true
  }
  return { receive, dispose }
}
