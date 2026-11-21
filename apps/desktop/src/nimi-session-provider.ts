/** Standardized Remote Harness Provider (`ai.nimi.dsh.sessions`, protocol `nimi.harness.session.v1`). */
import { createHash, randomUUID } from 'node:crypto'
import type { NimiElectronAppBusinessServices } from '@nimiplatform/kit/shell/electron/main'
import type { NimiIntegrationOperation, NimiIntegrationProviderCall } from '@nimiplatform/sdk/app'
import { NIMI_DSH_SESSION_PROVIDER_ID } from './nimi-ecosystem.ts'

const MAX_SUBMIT_TEXT_BYTES = 64 * 1024
const MAX_FEEDBACK_CHARS = 4_000
const MAX_ASSET_BYTES = 32 * 1024 * 1024
const POLL_WAIT_MS = 15_000
const RETRY_BACKOFF_MS = 1_500
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export type NimiSessionProviderServices = Pick<NimiElectronAppBusinessServices, 'integration' | 'storage'>

export type NimiSessionWorkerRpc = <T = unknown>(
  operation: string,
  payload?: unknown,
  signal?: AbortSignal,
  timeoutMs?: number,
) => Promise<T>

function op(
  name: string,
  effect: 'read' | 'write',
  description: string,
  inputSchema: object,
  outputSchema: object,
  extra?: {
    readonly displayName?: string
    readonly retryPolicy?: 'none' | 'safe'
    readonly snapshotRead?: boolean
    readonly assetTransfer?: 'to-provider' | 'to-consumer'
  },
): NimiIntegrationOperation {
  return {
    name,
    description,
    effect,
    supportsCancel: false,
    // Nimi Runtime provider admission (`provider.go`) requires `retryPolicy: 'none'` for app-provided operations.
    retryPolicy: 'none',
    inputSchemaJson: JSON.stringify(inputSchema),
    outputSchemaJson: JSON.stringify(outputSchema),
    ...(extra?.displayName ? { displayName: extra.displayName } : {}),
    ...(extra?.snapshotRead ? { snapshotRead: true } : {}),
    ...(extra?.assetTransfer ? { assetTransfer: extra.assetTransfer } : {}),
  }
}

/** Exact 13-operation `nimi.harness.session.v1` schema set shared symmetrically with `ai.nimi.harness.sessions`. */
export const NIMI_HARNESS_SESSION_OPERATIONS: readonly NimiIntegrationOperation[] = [
  op(
    'session.list',
    'read',
    'List available DSH sessions ordered by most recent activity.',
    {
      type: 'object',
      properties: { offset: { type: 'integer', minimum: 0 } },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['sessions', 'nextOffset'],
      properties: {
        sessions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'title'],
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              status: { type: 'string', enum: ['idle', 'running', 'waiting', 'error'] },
              hasPendingDecision: { type: 'boolean' },
              workspaceLabel: { type: 'string' },
              updatedAt: { type: 'integer' },
            },
          },
        },
        nextOffset: { type: ['integer', 'null'] },
      },
    },
    { displayName: 'List sessions' },
  ),
  op(
    'session.getHistory',
    'read',
    'Read chronological conversation history entries for a session.',
    {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        cursor: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['sessionId', 'entries', 'nextCursor'],
      properties: {
        sessionId: { type: 'string' },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'role', 'text'],
            properties: {
              id: { type: 'string' },
              role: { type: 'string', enum: ['user', 'assistant', 'tool'] },
              text: { type: 'string' },
              toolName: { type: 'string' },
              toolFailure: { type: 'string', enum: ['invalid-arguments', 'blocked', 'interrupted', 'other'] },
              truncated: { type: 'boolean' },
              timestamp: { type: 'integer' },
            },
          },
        },
        nextCursor: { type: ['integer', 'null'] },
      },
    },
    { displayName: 'Get session history' },
  ),
  op(
    'session.create',
    'write',
    'Create a new DSH session idempotently by requestId.',
    {
      type: 'object',
      required: ['requestId'],
      properties: {
        requestId: { type: 'string', format: 'uuid' },
        configRef: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['id', 'title'],
      properties: { id: { type: 'string' }, title: { type: 'string' } },
    },
    { displayName: 'Create session', retryPolicy: 'safe' },
  ),
  op(
    'session.submit',
    'write',
    'Submit a user prompt to a session idempotently by requestId.',
    {
      type: 'object',
      required: ['sessionId', 'requestId', 'text'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        requestId: { type: 'string', format: 'uuid' },
        text: { type: 'string', minLength: 1, maxLength: MAX_SUBMIT_TEXT_BYTES },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['requestId'],
      properties: { requestId: { type: 'string' } },
    },
    { displayName: 'Send prompt', retryPolicy: 'safe' },
  ),
  op(
    'session.inputStatus',
    'read',
    'Check delivery and completion status for a submitted requestId.',
    {
      type: 'object',
      required: ['sessionId', 'requestId'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        requestId: { type: 'string', format: 'uuid' },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['requestId', 'status'],
      properties: {
        requestId: { type: 'string' },
        status: { type: 'string', enum: ['not-found', 'queued', 'placed', 'done', 'unanswered'] },
      },
    },
    { displayName: 'Check prompt status' },
  ),
  op(
    'session.readAnswer',
    'read',
    'Read the bounded assistant answer for a submitted requestId.',
    {
      type: 'object',
      required: ['sessionId', 'requestId'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        requestId: { type: 'string', format: 'uuid' },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['requestId', 'status'],
      properties: {
        requestId: { type: 'string' },
        status: { type: 'string', enum: ['not-found', 'queued', 'placed', 'done', 'unanswered'] },
        text: { type: 'string' },
        truncated: { type: 'boolean' },
      },
    },
    { displayName: 'Read answer' },
  ),
  op(
    'session.stopInput',
    'write',
    'Cancel an active or queued prompt by requestId.',
    {
      type: 'object',
      required: ['sessionId', 'requestId'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        requestId: { type: 'string', format: 'uuid' },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['requestId', 'outcome'],
      properties: {
        requestId: { type: 'string' },
        outcome: { type: 'string', enum: ['not-found', 'settled', 'requested', 'check-again'] },
      },
    },
    { displayName: 'Stop prompt', retryPolicy: 'safe' },
  ),
  op(
    'session.observeProgress',
    'read',
    'Observe a cold-safe snapshot of current session progress without opening a model.',
    {
      type: 'object',
      required: ['sessionId'],
      properties: { sessionId: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['stage', 'turn', 'text', 'truncated'],
      properties: {
        stage: { type: 'string', enum: ['idle', 'queued', 'placed', 'generating', 'waiting', 'tools', 'done', 'unanswered'] },
        turn: { type: 'integer' },
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        activeTool: { type: 'string' },
        hasPendingDecision: { type: 'boolean' },
      },
    },
    { displayName: 'Observe progress', snapshotRead: true },
  ),
  op(
    'session.reviewDecision',
    'read',
    'Inspect any pending tool approval decision for a session.',
    {
      type: 'object',
      required: ['sessionId'],
      properties: { sessionId: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['state'],
      properties: {
        state: { type: 'string', enum: ['none', 'open-on-pc', 'review'] },
        taskId: { type: 'string' },
        revision: { type: 'integer' },
        tool: { type: 'string' },
        title: { type: 'string' },
        summary: { type: 'string' },
        argumentsJson: { type: 'string' },
        diffPreview: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['write', 'edit', 'command'] },
            path: { type: 'string' },
            content: { type: 'string' },
            command: { type: 'string' },
            replacements: {
              type: 'array',
              items: {
                type: 'object',
                required: ['oldText', 'newText'],
                properties: { oldText: { type: 'string' }, newText: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    { displayName: 'Review pending decision' },
  ),
  op(
    'session.resolveDecision',
    'write',
    'Approve or reject a pending tool approval decision with optional feedback.',
    {
      type: 'object',
      required: ['sessionId', 'taskId', 'revision', 'allow'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        taskId: { type: 'string', minLength: 1 },
        revision: { type: 'integer', minimum: 0 },
        allow: { type: 'boolean' },
        feedback: { type: 'string', maxLength: MAX_FEEDBACK_CHARS },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['outcome'],
      properties: { outcome: { type: 'string', enum: ['recorded', 'stale'] } },
    },
    { displayName: 'Resolve decision', retryPolicy: 'safe' },
  ),
  op(
    'session.listFiles',
    'read',
    'List workspace files and folders for a session.',
    {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        folder: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['items', 'nextOffset'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'ref', 'directory'],
            properties: {
              name: { type: 'string' },
              ref: { type: 'string' },
              directory: { type: 'boolean' },
              size: { type: 'integer' },
            },
          },
        },
        nextOffset: { type: ['integer', 'null'] },
      },
    },
    { displayName: 'List workspace files' },
  ),
  op(
    'session.importAttachment',
    'write',
    'Upload a file attachment into the session workspace.',
    {
      type: 'object',
      required: ['sessionId'],
      properties: { sessionId: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['fileId'],
      properties: { fileId: { type: 'string', format: 'uuid' } },
    },
    { displayName: 'Upload file to workspace', retryPolicy: 'none', assetTransfer: 'to-provider' },
  ),
  op(
    'session.downloadResult',
    'write',
    'Download a file from the session workspace by fileId or workspace ref.',
    {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        fileId: { type: 'string', format: 'uuid' },
        ref: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['fileId'],
      properties: {
        fileId: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
      },
    },
    { displayName: 'Download file from workspace', retryPolicy: 'none', assetTransfer: 'to-consumer' },
  ),
]

function parseInputObject(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw providerError('INVALID_ARGUMENT', 'inputJson must be valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw providerError('INVALID_ARGUMENT', 'inputJson must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function providerError(code: string, message: string): Error & { errorCode: string } {
  return Object.assign(new Error(message), { errorCode: code })
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key]
  if (typeof value !== 'string' || !value.trim()) throw providerError('INVALID_ARGUMENT', `${key} is required`)
  return value.trim()
}

function requireUuid(obj: Record<string, unknown>, key: string): string {
  const value = requireString(obj, key)
  if (!UUID_PATTERN.test(value)) throw providerError('INVALID_ARGUMENT', `${key} must be a UUID`)
  return value
}

function optionalNonNegInt(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw providerError('INVALID_ARGUMENT', `${key} must be a non-negative integer`)
  }
  return value
}

async function readAssetBytes(
  assets: NimiSessionProviderServices['storage']['assets'],
  relativePath: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const stream = await assets.read({ relativePath })
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream.body) {
    signal.throwIfAborted()
    total += chunk.byteLength
    if (total > MAX_ASSET_BYTES) {
      throw providerError('ASSET_TOO_LARGE', 'Attachment exceeds 32 MiB limit')
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, total)
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface RunningNimiSessionProvider {
  readonly targetRef: Promise<string | undefined>
  stop(invalidated?: boolean): Promise<void>
}

/**
 * Register and serve `ai.nimi.dsh.sessions` (`nimi.harness.session.v1`) for one live account scope.
 * Strictly honors `signal` on `onSessionInvalidated` and never unregisters under a replacement scope.
 */
export function startNimiSessionProvider(
  services: NimiSessionProviderServices,
  rpc: NimiSessionWorkerRpc,
  scopeSignal: AbortSignal,
): RunningNimiSessionProvider {
  const controller = new AbortController()
  const onScopeAbort = () => { controller.abort() }
  scopeSignal.addEventListener('abort', onScopeAbort, { once: true })
  if (scopeSignal.aborted) controller.abort()

  const inFlight = new Map<string, AbortController>()
  let registeredTargetRef: string | undefined
  let resolveTargetRef!: (value: string | undefined) => void
  const targetRef = new Promise<string | undefined>((resolve) => { resolveTargetRef = resolve })

  const executeCall = async (call: NimiIntegrationProviderCall): Promise<void> => {
    const callAbort = new AbortController()
    const onParentAbort = () => { callAbort.abort() }
    controller.signal.addEventListener('abort', onParentAbort, { once: true })
    if (controller.signal.aborted) callAbort.abort()
    inFlight.set(call.callId, callAbort)

    try {
      if (callAbort.signal.aborted) return
      const input = parseInputObject(call.inputJson)
      const complete = async (result: unknown, asset?: {
        readonly relativePath: string
        readonly source?: { readonly sha256: string; readonly mediaType: string; readonly sizeBytes: number }
      }) => {
        if (controller.signal.aborted || callAbort.signal.aborted) return { accepted: false }
        return services.integration.completeProvider({
          callId: call.callId,
          resultJson: JSON.stringify(result),
          errorCode: '',
          ...(asset ? { asset } : {}),
        })
      }

      switch (call.operation) {
        case 'session.list': {
          const offset = optionalNonNegInt(input, 'offset')
          const result = await rpc('remote.session.list', { ...(offset === undefined ? {} : { offset }) }, callAbort.signal)
          await complete(result)
          return
        }
        case 'session.getHistory': {
          const sessionId = requireString(input, 'sessionId')
          const cursor = optionalNonNegInt(input, 'cursor')
          const limit = optionalNonNegInt(input, 'limit')
          if (limit !== undefined && (limit < 1 || limit > 50)) {
            throw providerError('INVALID_ARGUMENT', 'limit must be between 1 and 50')
          }
          const result = await rpc('remote.session.getHistory', {
            sessionId,
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
          }, callAbort.signal)
          await complete(result)
          return
        }
        case 'session.create': {
          const requestId = requireUuid(input, 'requestId')
          const configRef = typeof input.configRef === 'string' && input.configRef.trim() ? input.configRef.trim() : undefined
          const result = await rpc('remote.session.create', {
            requestId,
            ...(configRef ? { configRef } : {}),
          }, callAbort.signal)
          await complete(result)
          return
        }
        case 'session.submit': {
          const sessionId = requireString(input, 'sessionId')
          const requestId = requireUuid(input, 'requestId')
          const text = typeof input.text === 'string' ? input.text : ''
          if (!text.trim() || Buffer.byteLength(text, 'utf8') > MAX_SUBMIT_TEXT_BYTES) {
            throw providerError('INVALID_ARGUMENT', 'text must be non-empty and at most 64 KiB')
          }
          const result = await rpc('remote.session.submit', { sessionId, requestId, text }, callAbort.signal)
          await complete(result)
          return
        }
        case 'session.inputStatus': {
          const sessionId = requireString(input, 'sessionId')
          const requestId = requireUuid(input, 'requestId')
          const result = await rpc('remote.session.inputStatus', { sessionId, requestId }, callAbort.signal)
          await complete(result)
          return
        }
        case 'session.readAnswer': {
          const sessionId = requireString(input, 'sessionId')
          const requestId = requireUuid(input, 'requestId')
          const result = await rpc('remote.session.readAnswer', { sessionId, requestId }, callAbort.signal)
          await complete(result)
          return
        }
        case 'session.stopInput': {
          const sessionId = requireString(input, 'sessionId')
          const requestId = requireUuid(input, 'requestId')
          const result = await rpc('remote.session.stopInput', { sessionId, requestId }, callAbort.signal)
          await complete(result)
          return
        }
        case 'session.observeProgress': {
          const sessionId = requireString(input, 'sessionId')
          const result = await rpc('remote.session.observeProgress', {
            sessionId,
            ...(call.afterSnapshot === undefined ? {} : { afterSnapshot: call.afterSnapshot }),
          }, callAbort.signal)
          await complete(result)
          return
        }
        case 'session.reviewDecision': {
          const sessionId = requireString(input, 'sessionId')
          const result = await rpc('remote.session.reviewDecision', { sessionId }, callAbort.signal)
          await complete(result)
          return
        }
        case 'session.resolveDecision': {
          const sessionId = requireString(input, 'sessionId')
          const taskId = requireString(input, 'taskId')
          const revision = optionalNonNegInt(input, 'revision')
          if (revision === undefined) throw providerError('INVALID_ARGUMENT', 'revision is required')
          if (typeof input.allow !== 'boolean') throw providerError('INVALID_ARGUMENT', 'allow must be a boolean')
          const feedback = typeof input.feedback === 'string' ? input.feedback.slice(0, MAX_FEEDBACK_CHARS) : undefined
          const result = await rpc('remote.session.resolveDecision', {
            sessionId,
            taskId,
            revision,
            allow: input.allow,
            ...(feedback === undefined ? {} : { feedback }),
          }, callAbort.signal)
          await complete(result)
          return
        }
        case 'session.listFiles': {
          const sessionId = requireString(input, 'sessionId')
          const folder = typeof input.folder === 'string' ? input.folder : undefined
          const offset = optionalNonNegInt(input, 'offset')
          const result = await rpc('remote.session.listFiles', {
            sessionId,
            ...(folder === undefined ? {} : { folder }),
            ...(offset === undefined ? {} : { offset }),
          }, callAbort.signal)
          await complete(result)
          return
        }
        case 'session.importAttachment': {
          const sessionId = requireString(input, 'sessionId')
          const offered = call.offeredAsset
          if (!offered) throw providerError('ASSET_REQUIRED', 'Offered asset metadata is required')
          if (offered.sizeBytes > MAX_ASSET_BYTES) throw providerError('ASSET_TOO_LARGE', 'Attachment exceeds 32 MiB limit')
          await rpc('remote.session.checkAttachmentWorkspace', { sessionId }, callAbort.signal)
          const fileId = randomUUID()
          const relativePath = `remote-in/${call.callId}/${fileId}`
          const completion = await complete({ fileId }, { relativePath })
          if (!completion.accepted || controller.signal.aborted || callAbort.signal.aborted) return
          try {
            const bytes = await readAssetBytes(services.storage.assets, relativePath, callAbort.signal)
            const actualSha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
            if (actualSha !== offered.sha256) {
              throw providerError('ASSET_INTEGRITY_FAILED', 'Uploaded attachment checksum mismatch')
            }
            await rpc('remote.session.materializeAttachment', {
              sessionId,
              fileId,
              mediaType: offered.mediaType,
              dataBase64: bytes.toString('base64'),
            }, callAbort.signal)
          } finally {
            void services.storage.assets.remove(relativePath).catch(() => undefined)
          }
          return
        }
        case 'session.downloadResult': {
          const sessionId = requireString(input, 'sessionId')
          const fileId = input.fileId === undefined ? undefined : requireUuid(input, 'fileId')
          const ref = typeof input.ref === 'string' && input.ref.trim() ? input.ref.trim() : undefined
          if (!fileId && !ref) throw providerError('INVALID_ARGUMENT', 'Either fileId or ref is required')
          const read = await rpc<{
            readonly fileId: string
            readonly name: string
            readonly mediaType: string
            readonly sizeBytes: number
            readonly dataBase64: string
          }>('remote.session.readFile', {
            sessionId,
            ...(fileId ? { fileId } : {}),
            ...(ref ? { ref } : {}),
          }, callAbort.signal)
          if (read.sizeBytes > MAX_ASSET_BYTES) throw providerError('ASSET_TOO_LARGE', 'Result file exceeds 32 MiB limit')
          const bytes = Buffer.from(read.dataBase64, 'base64')
          const relativePath = `remote-out/${call.callId}/${read.fileId}`
          const asset = await services.storage.assets.write({
            relativePath,
            mediaType: read.mediaType || 'application/octet-stream',
            body: bytes,
            overwrite: true,
          })
          try {
            await complete({ fileId: read.fileId, name: read.name }, {
              relativePath,
              source: {
                sha256: asset.sha256,
                mediaType: asset.mediaType ?? 'application/octet-stream',
                sizeBytes: asset.sizeBytes,
              },
            })
          } finally {
            void services.storage.assets.remove(relativePath).catch(() => undefined)
          }
          return
        }
        default:
          throw providerError('UNSUPPORTED_OPERATION', `Unknown operation "${call.operation}"`)
      }
    } catch (error) {
      if (controller.signal.aborted || callAbort.signal.aborted) return
      const errorCode = typeof (error as { errorCode?: unknown })?.errorCode === 'string'
        ? (error as { errorCode: string }).errorCode
        : typeof (error as { code?: unknown })?.code === 'string'
          ? (error as { code: string }).code
          : 'PROVIDER_EXECUTION_FAILED'
      await services.integration.completeProvider({
        callId: call.callId,
        resultJson: '',
        errorCode,
      }).catch(() => undefined)
    } finally {
      inFlight.delete(call.callId)
      controller.signal.removeEventListener('abort', onParentAbort)
    }
  }

  const loop = (async () => {
    try {
      if (controller.signal.aborted) {
        resolveTargetRef(undefined)
        return
      }
      const target = await services.integration.registerProvider({
        integrationId: NIMI_DSH_SESSION_PROVIDER_ID,
        displayName: 'Nimi DSH',
        skill: 'Remote session control, approval review, and workspace file access for Nimi DSH.',
        operations: [...NIMI_HARNESS_SESSION_OPERATIONS],
      })
      registeredTargetRef = target.targetRef
      resolveTargetRef(target.targetRef)

      while (!controller.signal.aborted) {
        try {
          const poll = await services.integration.pollProvider({ waitMs: POLL_WAIT_MS })
          if (controller.signal.aborted) break
          for (const canceledId of poll.canceledCallIds ?? []) {
            inFlight.get(canceledId)?.abort()
          }
          for (const call of poll.calls ?? []) {
            if (controller.signal.aborted) break
            void executeCall(call)
          }
        } catch (error) {
          if (controller.signal.aborted) break
          const reasonCode = (error as { reasonCode?: string } | null)?.reasonCode
          if (reasonCode === 'session-invalid' || reasonCode === 'revoked' || reasonCode === 'runtime-unauthenticated') {
            break
          }
          await delay(RETRY_BACKOFF_MS, controller.signal)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('[nimi-dsh] integration provider failed:', error instanceof Error ? error.message : String(error))
      }
      resolveTargetRef(undefined)
    }
  })()

  let stopped = false
  return {
    targetRef,
    async stop(invalidated = false): Promise<void> {
      if (stopped) return
      stopped = true
      controller.abort()
      scopeSignal.removeEventListener('abort', onScopeAbort)
      for (const abort of inFlight.values()) abort.abort()
      inFlight.clear()
      await loop.catch(() => undefined)
      // Never call unregisterProvider after session invalidation — the old scope is already retired.
      if (!invalidated && registeredTargetRef && !scopeSignal.aborted) {
        await services.integration.unregisterProvider({ targetRef: registeredTargetRef }).catch(() => undefined)
      }
    },
  }
}
