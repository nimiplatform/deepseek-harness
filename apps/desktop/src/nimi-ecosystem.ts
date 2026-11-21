/** Nimi Ecosystem Host bridge: integration consumption, automatic activity open-requests, Home chat handoff, and Host<->Worker RPC. */
import { createHash, randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { NimiElectronAppBusinessServices } from '@nimiplatform/kit/shell/electron/main'
import {
  createNimiCloudAIConfigCapabilityIntent,
  createNimiLocalAIConfigCapabilityIntent,
  runtimeAIConfigStructToJson,
} from '@nimiplatform/sdk/ai'
import type { NimiIntegrationCall, NimiIntegrationTarget, NimiAppActivityPutInput } from '@nimiplatform/sdk/app'
import { extractNimiErrorFields } from '@nimiplatform/sdk/types'
import type {
  NimiDesktopAiConfigIntent,
  NimiDesktopAiConfigOverwriteInput,
  NimiDesktopAiConfigSnapshot,
  NimiDesktopIntegrationTargetView,
} from './ipc.ts'

export const NIMI_DSH_SESSION_PROVIDER_ID = 'ai.nimi.dsh.sessions'

function isProtobufStruct(value: unknown): value is { fields: Record<string, unknown> } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'fields' in value && typeof (value as { fields?: unknown }).fields === 'object'
    && (value as { fields?: unknown }).fields !== null
}

function unwrapStructLike(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  if (isProtobufStruct(value)) {
    return runtimeAIConfigStructToJson(value as Parameters<typeof runtimeAIConfigStructToJson>[0]) as Record<string, unknown>
  }
  return value as Record<string, unknown>
}

function projectAiConfigIntentForUi(raw: unknown): NimiDesktopAiConfigIntent {
  const intent = raw as Record<string, unknown>
  const capabilityContract = typeof intent.capabilityContract === 'string' ? intent.capabilityContract : ''
  const requiredFeatures = Array.isArray(intent.requiredFeatures)
    ? intent.requiredFeatures.filter((item): item is string => typeof item === 'string')
    : []
  const defaults = unwrapStructLike(intent.defaults)
  const route = intent.route as Record<string, unknown> | undefined
  if (route?.oneofKind === 'cloud' && typeof route.cloud === 'object' && route.cloud !== null) {
    const cloud = route.cloud as Record<string, unknown>
    const providerModelTarget = unwrapStructLike(cloud.providerModelTarget) ?? {}
    const implementation = typeof cloud.implementation === 'object' && cloud.implementation !== null && !Array.isArray(cloud.implementation)
      ? cloud.implementation as Record<string, unknown>
      : undefined
    return {
      capabilityContract,
      requiredFeatures,
      ...(defaults && Object.keys(defaults).length > 0 ? { defaults } : {}),
      route: {
        oneofKind: 'cloud',
        cloud: {
          connectorRef: typeof cloud.connectorRef === 'string' ? cloud.connectorRef : '',
          ...(implementation ? { implementation } : {}),
          providerModelTarget,
        },
      },
    }
  }
  if (route?.oneofKind === 'local') {
    const local = (typeof route.local === 'object' && route.local !== null ? route.local : {}) as Record<string, unknown>
    return {
      capabilityContract,
      requiredFeatures,
      ...(defaults && Object.keys(defaults).length > 0 ? { defaults } : {}),
      route: {
        oneofKind: 'local',
        local: typeof local.loadoutRef === 'string' && local.loadoutRef ? { loadoutRef: local.loadoutRef } : {},
      },
    }
  }
  return {
    capabilityContract,
    requiredFeatures,
    ...(defaults && Object.keys(defaults).length > 0 ? { defaults } : {}),
    route: { oneofKind: undefined },
  }
}

/** Convert SDK Protobuf Struct fields inside an AIConfig snapshot into plain JSON objects for renderer UI. */
export function projectAiConfigSnapshotForUi<T extends { config?: { capabilities?: readonly unknown[] } | null }>(
  snapshot: T,
): T & Pick<NimiDesktopAiConfigSnapshot, 'config'> {
  if (!snapshot.config || !Array.isArray(snapshot.config.capabilities)) {
    return snapshot as T & Pick<NimiDesktopAiConfigSnapshot, 'config'>
  }
  return {
    ...snapshot,
    config: {
      ...snapshot.config,
      capabilities: snapshot.config.capabilities.map(projectAiConfigIntentForUi),
    },
  }
}

/** Compile plain-JSON UI capability intents into canonical SDK AIConfig intents with Protobuf Structs. */
export function compileAiConfigOverwriteInput(
  input: NimiDesktopAiConfigOverwriteInput,
): Parameters<NimiElectronAppBusinessServices['aiConfig']['overwrite']>[0] {
  const capabilities = (Array.isArray(input.capabilities) ? input.capabilities : []).flatMap((intent) => {
    const defaults = intent.defaults && Object.keys(intent.defaults).length > 0
      ? intent.defaults as Record<string, never>
      : undefined
    if (intent.route.oneofKind === 'cloud') {
      const target = unwrapStructLike(intent.route.cloud.providerModelTarget) ?? {}
      return [createNimiCloudAIConfigCapabilityIntent({
        capabilityContract: intent.capabilityContract,
        connectorRef: intent.route.cloud.connectorRef,
        requiredFeatures: intent.requiredFeatures,
        ...(defaults ? { defaults } : {}),
        implementation: intent.route.cloud.implementation as never,
        providerModelTarget: target as never,
      })]
    }
    if (intent.route.oneofKind === 'local') {
      return [createNimiLocalAIConfigCapabilityIntent({
        capabilityContract: intent.capabilityContract,
        requiredFeatures: intent.requiredFeatures,
        ...(defaults ? { defaults } : {}),
      })]
    }
    return []
  })
  return {
    ...(input.record ? { record: input.record } : {}),
    expectedRevision: input.expectedRevision,
    capabilities,
  } as Parameters<NimiElectronAppBusinessServices['aiConfig']['overwrite']>[0]
}

const MAX_INTEGRATION_INPUT_BYTES = 128 * 1024
const MAX_HOME_CHAT_IMPORT_BYTES = 4 * 1024 * 1024
const MAX_HOME_CHAT_MESSAGES = 500
const DEFAULT_WORKER_RPC_TIMEOUT_MS = 30_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export interface NimiWorkerIntegrationOperation {
  readonly name: string
  readonly displayName?: string
  readonly description: string
  readonly effect: 'read' | 'write' | string
  readonly inputSchemaJson: string
  readonly outputSchemaJson: string
  readonly supportsCancel: boolean
  readonly retryPolicy: string
}

export interface NimiWorkerIntegrationTarget {
  readonly targetRef: string
  readonly integrationId: string
  readonly displayName: string
  readonly accountLabel: string
  readonly kind: string
  readonly available: boolean
  readonly skill: string
  readonly permittedOperations: readonly string[]
  readonly operations: readonly NimiWorkerIntegrationOperation[]
}

export interface ParsedHomeChatMessage {
  readonly role: 'user' | 'assistant' | 'system'
  readonly text: string
  readonly timestamp?: number
}

export interface ParsedNimiHomeChatExport {
  readonly format: 'nimi.home-chat.v1'
  readonly digest: string
  readonly title: string
  readonly messages: readonly ParsedHomeChatMessage[]
  readonly draft?: string
}

/** Exclude this harness's own remote session provider and expose only Home-permitted operations. */
export function projectIntegrationCatalogForUi(
  targets: readonly NimiIntegrationTarget[],
): NimiDesktopIntegrationTargetView[] {
  const result: NimiDesktopIntegrationTargetView[] = []
  for (const target of targets) {
    if (target.integrationId === NIMI_DSH_SESSION_PROVIDER_ID) continue
    const permitted = new Set(target.permittedOperations)
    const operations = target.operations
      .filter(operation => permitted.has(operation.name))
      .map(operation => ({
        name: operation.name,
        ...(operation.displayName ? { displayName: operation.displayName } : {}),
        description: operation.description,
        effect: operation.effect,
      }))
    if (operations.length === 0) continue
    result.push({
      targetRef: target.targetRef,
      integrationId: target.integrationId,
      displayName: target.displayName,
      accountLabel: target.accountLabel,
      kind: target.kind,
      available: target.available,
      permittedOperations: operations.map(op => op.name),
      operations,
    })
  }
  return result
}

/** Project granted targets (both read and write ops) with exact schemas for agent discovery & execution. */
export function projectIntegrationCatalogForWorker(
  targets: readonly NimiIntegrationTarget[],
): NimiWorkerIntegrationTarget[] {
  const result: NimiWorkerIntegrationTarget[] = []
  for (const target of targets) {
    if (target.integrationId === NIMI_DSH_SESSION_PROVIDER_ID) continue
    const permitted = new Set(target.permittedOperations)
    const operations = target.operations
      .filter(operation => permitted.has(operation.name))
      .map(operation => ({
        name: operation.name,
        ...(operation.displayName ? { displayName: operation.displayName } : {}),
        description: operation.description,
        effect: operation.effect,
        inputSchemaJson: operation.inputSchemaJson,
        outputSchemaJson: operation.outputSchemaJson,
        supportsCancel: operation.supportsCancel,
        retryPolicy: operation.retryPolicy,
      }))
    if (operations.length === 0) continue
    result.push({
      targetRef: target.targetRef,
      integrationId: target.integrationId,
      displayName: target.displayName,
      accountLabel: target.accountLabel,
      kind: target.kind,
      available: target.available,
      skill: typeof target.skill === 'string' ? target.skill : '',
      permittedOperations: operations.map(op => op.name),
      operations,
    })
  }
  return result
}

function extractMessageText(entry: Record<string, unknown>): string {
  if (typeof entry.text === 'string') return entry.text
  if (typeof entry.content === 'string') return entry.content
  if (Array.isArray(entry.content)) {
    return entry.content
      .map((part) => {
        if (typeof part === 'string') return part
        if (typeof part === 'object' && part !== null && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed)
  }
  return undefined
}

/** Validate and normalize a Nimi Home chat export (`nimi.home-chat.v1`) with deterministic content digest. */
export function parseNimiHomeChatExport(sourceJson: string): ParsedNimiHomeChatExport {
  if (typeof sourceJson !== 'string' || sourceJson.trim().length === 0) {
    throw new Error('Home chat export must be a non-empty JSON string.')
  }
  if (Buffer.byteLength(sourceJson, 'utf8') > MAX_HOME_CHAT_IMPORT_BYTES) {
    throw new Error('Home chat export exceeds the 4 MiB size limit.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(sourceJson)
  } catch {
    throw new Error('Home chat export is not valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Home chat export must be a JSON object.')
  }
  const record = parsed as Record<string, unknown>
  if (record.format !== 'nimi.home-chat.v1') {
    throw new Error(`Unsupported Home chat export format: expected "nimi.home-chat.v1", got "${String(record.format ?? '')}".`)
  }
  if (!Array.isArray(record.messages)) {
    throw new Error('Home chat export must contain a chronological messages array.')
  }
  if (record.messages.length > MAX_HOME_CHAT_MESSAGES) {
    throw new Error(`Home chat export exceeds the ${MAX_HOME_CHAT_MESSAGES}-message limit.`)
  }
  const messages: ParsedHomeChatMessage[] = []
  for (let i = 0; i < record.messages.length; i++) {
    const item = record.messages[i]
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`Home chat export message at index ${i} must be an object.`)
    }
    const msg = item as Record<string, unknown>
    const role = msg.role
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      throw new Error(`Home chat export message at index ${i} has unsupported role "${String(role ?? '')}".`)
    }
    const text = extractMessageText(msg)
    const timestamp = parseTimestamp(msg.timestamp ?? msg.createdAt)
    messages.push({
      role,
      text,
      ...(timestamp === undefined ? {} : { timestamp }),
    })
  }
  const draft = typeof record.draft === 'string' && record.draft.length > 0 ? record.draft : undefined
  if (messages.length === 0 && draft === undefined) {
    throw new Error('Home chat export contains neither messages nor a draft.')
  }
  const rawTitle = typeof record.title === 'string' ? record.title.trim() : ''
  const firstUserText = messages.find(message => message.role === 'user' && message.text.trim().length > 0)?.text.trim()
  const fallbackTitle = (firstUserText ?? draft?.trim() ?? 'Imported from Nimi Home').slice(0, 80)
  const title = (rawTitle || fallbackTitle || 'Imported from Nimi Home').slice(0, 120)
  const sourceId = typeof record.conversationId === 'string' ? record.conversationId
    : typeof record.sourceId === 'string' ? record.sourceId : undefined
  const digest = createHash('sha256')
    .update(JSON.stringify({
      format: 'nimi.home-chat.v1',
      ...(sourceId ? { sourceId } : {}),
      title,
      messages: messages.map(m => ({ role: m.role, text: m.text })),
      draft: draft ?? '',
    }))
    .digest('hex')
  return {
    format: 'nimi.home-chat.v1',
    digest,
    title,
    messages,
    ...(draft === undefined ? {} : { draft }),
  }
}

export type NimiEcosystemServices = Pick<NimiElectronAppBusinessServices, 'integration' | 'activity'>

export interface NimiEcosystemBridge {
  receive(message: unknown): boolean
  callWorker<T = unknown>(operation: string, payload?: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<T>
  dispose(): void
}

function projectIntegrationCall(call: NimiIntegrationCall) {
  return {
    callId: call.callId,
    targetRef: call.targetRef,
    operation: call.operation,
    status: call.status,
    resultJson: call.resultJson,
    errorCode: call.errorCode,
    targetDisplayName: call.targetDisplayName,
    accountLabel: call.accountLabel,
    createdAt: call.createdAt,
    updatedAt: call.updatedAt,
    ...(call.status === 'accepted' || call.status === 'unconfirmed' ? { uncertainEffect: true } : {}),
  }
}

/**
 * Bridge Nimi Ecosystem integration consumption, activity publishing, and Host->Worker RPC
 * across the private parent/child IPC channel of one Desktop Host worker.
 */
export function serveNimiEcosystem(
  child: ChildProcess,
  services: NimiEcosystemServices,
): NimiEcosystemBridge {
  let closed = false
  const pendingWorkerRpc = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    cleanup: () => void
  }>()

  function dispose(): void {
    if (closed) return
    closed = true
    for (const entry of pendingWorkerRpc.values()) {
      entry.cleanup()
      entry.reject(new Error('Nimi Desktop Host disconnected.'))
    }
    pendingWorkerRpc.clear()
  }

  child.once('disconnect', dispose)
  child.once('exit', dispose)

  const reply = (id: string, body: object) => {
    if (child.connected && !closed) {
      child.send({ type: 'nimi-ecosystem-reply', id, ...body }, () => undefined)
    }
  }

  function callWorker<T = unknown>(
    operation: string,
    payload?: unknown,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_WORKER_RPC_TIMEOUT_MS,
  ): Promise<T> {
    if (closed || !child.connected) {
      return Promise.reject(new Error('Desktop worker is unavailable.'))
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'))
    }
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const entry = pendingWorkerRpc.get(id)
        if (!entry) return
        pendingWorkerRpc.delete(id)
        entry.cleanup()
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Worker RPC aborted.'))
      }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const timer = setTimeout(() => {
        const entry = pendingWorkerRpc.get(id)
        if (!entry) return
        pendingWorkerRpc.delete(id)
        entry.cleanup()
        reject(new Error(`Worker RPC "${operation}" timed out.`))
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      pendingWorkerRpc.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup,
      })
      child.send({ type: 'nimi-worker-rpc', id, operation, payload }, (error) => {
        if (error !== null) {
          const entry = pendingWorkerRpc.get(id)
          if (!entry) return
          pendingWorkerRpc.delete(id)
          entry.cleanup()
          reject(error)
        }
      })
    })
  }

  function receive(message: unknown): boolean {
    if (typeof message !== 'object' || message === null || !('type' in message)) return false
    const record = message as Record<string, unknown>

    if (record.type === 'nimi-worker-rpc-reply') {
      const id = record.id
      if (typeof id !== 'string') return true
      const entry = pendingWorkerRpc.get(id)
      if (!entry) return true
      pendingWorkerRpc.delete(id)
      entry.cleanup()
      if (typeof record.error === 'string') {
        const err = new Error(record.error)
        if (typeof record.errorCode === 'string') Object.assign(err, { code: record.errorCode })
        entry.reject(err)
      } else {
        entry.resolve(record.result)
      }
      return true
    }

    if (record.type !== 'nimi-ecosystem') return false
    const id = record.id
    const operation = record.operation
    if (typeof id !== 'string' || !UUID_PATTERN.test(id) || typeof operation !== 'string') return true
    if (closed || !child.connected) return true

    if (operation === 'integration-list') {
      void services.integration.listCatalog().then(
        targets => reply(id, { targets: projectIntegrationCatalogForWorker(targets) }),
        error => reply(id, { error: extractNimiErrorFields(error) }),
      )
      return true
    }

    if (operation === 'integration-invoke') {
      const targetRef = record.targetRef
      const opName = record.operationName
      const inputJson = record.inputJson
      if (typeof targetRef !== 'string' || !targetRef.trim()
        || typeof opName !== 'string' || !opName.trim()
        || typeof inputJson !== 'string' || Buffer.byteLength(inputJson, 'utf8') > MAX_INTEGRATION_INPUT_BYTES) {
        reply(id, { error: { reasonCode: 'NIMI_INTEGRATION_INPUT_INVALID', message: 'Invalid integration invocation input.' } })
        return true
      }
      try {
        JSON.parse(inputJson)
      } catch {
        reply(id, { error: { reasonCode: 'NIMI_INTEGRATION_INPUT_INVALID', message: 'Integration inputJson must be valid JSON.' } })
        return true
      }
      // Never retry integration calls automatically; preserve uncertain/accepted receipts verbatim.
      void services.integration.invoke({ targetRef, operation: opName, inputJson }).then(
        call => reply(id, { call: projectIntegrationCall(call) }),
        error => reply(id, { error: extractNimiErrorFields(error) }),
      )
      return true
    }

    if (operation === 'integration-get-call') {
      const callId = record.callId
      if (typeof callId !== 'string' || !callId.trim()) {
        reply(id, { error: { reasonCode: 'NIMI_INTEGRATION_CALL_ID_INVALID', message: 'callId is required.' } })
        return true
      }
      void services.integration.getCall({ callId }).then(
        call => reply(id, { call: projectIntegrationCall(call) }),
        error => reply(id, { error: extractNimiErrorFields(error) }),
      )
      return true
    }

    if (operation === 'integration-cancel-call') {
      const callId = record.callId
      if (typeof callId !== 'string' || !callId.trim()) {
        reply(id, { error: { reasonCode: 'NIMI_INTEGRATION_CALL_ID_INVALID', message: 'callId is required.' } })
        return true
      }
      void services.integration.cancelCall({ callId }).then(
        call => reply(id, { call: projectIntegrationCall(call) }),
        error => reply(id, { error: extractNimiErrorFields(error) }),
      )
      return true
    }

    if (operation === 'activity-put') {
      const input = record.input
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        reply(id, { error: { reasonCode: 'NIMI_ACTIVITY_INPUT_INVALID', message: 'Activity payload must be an object.' } })
        return true
      }
      const candidate = input as Record<string, unknown>
      if (typeof candidate.key !== 'string' || !candidate.key.trim()
        || typeof candidate.revision !== 'number' || !Number.isSafeInteger(candidate.revision) || candidate.revision < 1
        || (candidate.kind !== 'activity' && candidate.kind !== 'todo')
        || typeof candidate.attention !== 'boolean'
        || typeof candidate.title !== 'string' || !candidate.title.trim()
        || typeof candidate.type !== 'string' || !candidate.type.trim()
        || typeof candidate.occurredAt !== 'string') {
        reply(id, { error: { reasonCode: 'NIMI_ACTIVITY_INPUT_INVALID', message: 'Malformed activity payload.' } })
        return true
      }
      const payload: NimiAppActivityPutInput = {
        key: candidate.key,
        revision: candidate.revision,
        kind: candidate.kind,
        attention: candidate.attention,
        title: candidate.title.slice(0, 240),
        type: candidate.type,
        occurredAt: candidate.occurredAt,
        ...(typeof candidate.summary === 'string' && candidate.summary.trim() ? { summary: candidate.summary.slice(0, 500) } : {}),
        ...(typeof candidate.objectRef === 'string' && candidate.objectRef.trim() ? { objectRef: candidate.objectRef } : {}),
        ...(candidate.todoState === 'open' || candidate.todoState === 'completed' || candidate.todoState === 'cancelled'
          ? { todoState: candidate.todoState }
          : {}),
      }
      void services.activity.put(payload).then(
        result => reply(id, { activityId: result.record.activityId, changed: result.changed }),
        error => reply(id, { error: extractNimiErrorFields(error) }),
      )
      return true
    }

    reply(id, { error: { reasonCode: 'NIMI_ECOSYSTEM_REQUEST_INVALID', message: `Unknown ecosystem operation "${operation}".` } })
    return true
  }

  return { receive, callWorker, dispose }
}

/** Register `services.activity.onOpenRequest` to focus Nimi DSH and jump straight to `session:<sessionId>`. */
export function installNimiActivityOpenHandler(
  activity: NimiElectronAppBusinessServices['activity'],
  callbacks: {
    sessionExists(sessionId: string): Promise<boolean>
    focusAndOpenSession(sessionId: string): Promise<void> | void
  },
): () => Promise<void> {
  const registration = activity.onOpenRequest(async (request) => {
    const objectRef = typeof request.objectRef === 'string' ? request.objectRef.trim() : ''
    if (!objectRef.startsWith('session:')) return 'object-unavailable'
    const sessionId = objectRef.slice('session:'.length).trim()
    if (!sessionId) return 'object-unavailable'
    const exists = await callbacks.sessionExists(sessionId).catch(() => false)
    if (!exists) return 'object-unavailable'
    await callbacks.focusAndOpenSession(sessionId)
    return 'opened'
  })
  let stopped = false
  return async () => {
    if (stopped) return
    stopped = true
    await registration.stop().catch(() => undefined)
  }
}
