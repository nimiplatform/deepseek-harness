/**
 * Worker-side Nimi ecosystem plugin:
 * - Registers integration-consume tools (`find_nimi_integrations`, `invoke_nimi_integration`,
 *   `check_nimi_integration_receipt`) and `nimi_transcribe_audio`.
 * - Publishes automatic Nimi Home activity items on pending approvals and turn completion.
 * - Bridges dual-channel approvals (Desktop UI + Remote Companion) with structured diff previews.
 * - Handles Host -> Worker RPCs for `ai.nimi.dsh.sessions` (`nimi.harness.session.v1`) and
 *   `nimi.home-chat.v1` conversation imports.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type AssistantMessage, type ContentBlock, type MessageId, type SystemMessage, type ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { transcribeNimiAudio } from './nimi-text-client.ts'

const NIMI_DSH_SESSION_PROVIDER_ID = 'ai.nimi.dsh.sessions'
const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const MAX_REMOTE_FILE_BYTES = 32 * 1024 * 1024
const MAX_RESULT_JSON_CHARS = 32_768
const MAX_ANSWER_CHARS = 16_384
const MAX_PROGRESS_TEXT_CHARS = 8_192
const MAX_HISTORY_TEXT_CHARS = 8_192
const MAX_ARGUMENTS_JSON_CHARS = 32_768
const MAX_SCHEMA_PREVIEW_CHARS = 2_000
const SESSION_LIST_PAGE_SIZE = 25
const FILE_LIST_PAGE_SIZE = 50
const DEFAULT_ECOSYSTEM_TIMEOUT_MS = 60_000

const AUDIO_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.aac': 'audio/aac',
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ...AUDIO_MIME_BY_EXT,
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.tsx': 'text/typescript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
}

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
  'application/zip': '.zip',
}

export interface NimiWorkerIntegrationOperation {
  readonly name: string
  readonly displayName?: string
  readonly description: string
  readonly effect: 'read' | 'write'
  readonly retryPolicy: 'none' | 'safe'
  readonly supportsCancel: boolean
  readonly inputSchemaJson: string
  readonly outputSchemaJson: string
}

export interface NimiWorkerIntegrationTarget {
  readonly targetRef: string
  readonly integrationId: string
  readonly displayName: string
  readonly skill?: string
  readonly available: boolean
  readonly operations: readonly NimiWorkerIntegrationOperation[]
}

export interface NimiWorkerIntegrationInvokeResult {
  readonly callId: string
  readonly status: 'accepted' | 'completed' | 'failed' | 'canceled' | 'unconfirmed'
  readonly resultJson?: string
  readonly errorCode?: string
  readonly message?: string
  readonly uncertainEffect?: boolean
}

export interface NimiEcosystemClient {
  listIntegrations(signal?: AbortSignal): Promise<readonly NimiWorkerIntegrationTarget[]>
  invokeIntegration(input: {
    readonly targetRef: string
    readonly operation: string
    readonly inputJson: string
    readonly idempotencyKey?: string
    readonly timeoutMs?: number
  }, signal?: AbortSignal): Promise<NimiWorkerIntegrationInvokeResult>
  getIntegrationCall(callId: string, signal?: AbortSignal): Promise<NimiWorkerIntegrationInvokeResult>
  cancelIntegrationCall(callId: string, signal?: AbortSignal): Promise<{ readonly canceled: boolean }>
  putActivity(input: {
    readonly objectRef: string
    readonly title: string
    readonly summary?: string
    readonly attention: boolean
    readonly revision: number
  }): Promise<void>
  transcribeAudio(input: {
    readonly audioBytesBase64: string
    readonly mimeType: string
    readonly language?: string
    readonly prompt?: string
    readonly configRef?: string
  }, signal?: AbortSignal): Promise<{ readonly text: string }>
}

export interface RemoteDiffPreview {
  readonly kind: 'write' | 'edit' | 'command'
  readonly path?: string
  readonly content?: string
  readonly command?: string
  readonly replacements?: readonly { readonly oldText: string; readonly newText: string }[]
}

export interface NimiHomeChatPayload {
  readonly format: 'nimi.home-chat.v1'
  readonly title: string
  readonly messages: readonly {
    readonly role: 'user' | 'assistant'
    readonly text: string
    readonly timestamp?: number
  }[]
  readonly draft?: string
  readonly digest: string
}

function isHomeChatMessage(value: unknown): value is NimiHomeChatPayload['messages'][number] {
  if (typeof value !== 'object' || value === null) return false
  return 'role' in value && (value.role === 'user' || value.role === 'assistant')
    && 'text' in value && typeof value.text === 'string'
    && (!('timestamp' in value) || (typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)))
}

type HomeChatSeedEventType = 'turn/start' | 'step/start' | 'system/message' | 'user/message'
  | 'assistant/message' | 'step/end' | 'turn/end' | 'session/title'
type HomeChatSeedEvent = {
  [K in HomeChatSeedEventType]: Omit<SessionEvent<K>, 'seq' | 'time'>
}[HomeChatSeedEventType]

interface PendingDecisionRecord {
  readonly sessionId: string
  readonly taskId: string
  readonly revision: number
  readonly tool: string
  readonly title: string
  readonly summary: string
  readonly argumentsJson: string
  readonly diffPreview?: RemoteDiffPreview
  settled: boolean
  resolveRemote(outcome: 'allowed-once' | 'rejected', feedback?: string): void
}

interface TrackedRemoteRequest {
  readonly sessionId: string
  readonly requestId: string
  status: 'queued' | 'placed' | 'done' | 'unanswered'
  answerText: string
  truncated: boolean
}

interface ImportedHomeChatRecord {
  readonly sessionId: string
  readonly title: string
  readonly importedCount: number
}

interface NimiWorkerRpcReply {
  readonly type: 'nimi-worker-rpc-reply'
  readonly id: string
  readonly result?: unknown
  readonly error?: string
  readonly errorCode?: string
}

function rpcError(code: string, message: string): Error & { errorCode: string } {
  return Object.assign(new Error(message), { errorCode: code })
}

function truncateText(text: string, maxChars: number): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}

function safeJsonStringify(value: unknown, maxChars: number): { readonly text: string; readonly truncated: boolean } {
  let raw: string
  try {
    raw = JSON.stringify(value) ?? '{}'
  } catch {
    raw = '{}'
  }
  return truncateText(raw, maxChars)
}

function extractTextFromBlocks(blocks: readonly ContentBlock[] | undefined): string {
  if (!Array.isArray(blocks) || blocks.length === 0) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text)
    } else if (block.type === 'tool-call') {
      parts.push(`[tool: ${block.name}]`)
    } else if (block.type === 'file') {
      parts.push(`[file: ${block.attachment.name}]`)
    } else if (block.type === 'image') {
      parts.push('[image]')
    }
  }
  return parts.join('\n')
}

function guessMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

function guessAudioMimeType(filePath: string): string | undefined {
  const ext = extname(filePath).toLowerCase()
  return AUDIO_MIME_BY_EXT[ext]
}

function extensionForMimeType(mediaType: string): string {
  const base = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  return EXT_BY_MIME[base] ?? '.bin'
}

/**
 * Strictly resolve a relative path inside a workspace root without allowing
 * absolute escapes, `..` traversal, or symlink escapes outside `workspaceRoot`.
 */
export async function resolveContainedWorkspacePath(
  workspaceRoot: string,
  relativePath: string,
  options?: { readonly allowNonExistentLeaf?: boolean },
): Promise<{ readonly rootReal: string; readonly targetReal: string; readonly relativePosix: string }> {
  const normalized = relativePath.replace(/\\/gu, '/').trim()
  if (normalized.includes('\0')) throw rpcError('INVALID_PATH', 'Path contains invalid null byte')
  if (isAbsolute(normalized) || normalized.startsWith('/')) {
    throw rpcError('INVALID_PATH', 'Path must be relative to the session workspace')
  }
  const segments = normalized === '' || normalized === '.' ? [] : normalized.split('/').filter(Boolean)
  if (segments.some(seg => seg === '..')) {
    throw rpcError('PATH_OUTSIDE_WORKSPACE', 'Path traversal outside the workspace is forbidden')
  }
  const rootReal = await realpath(workspaceRoot)
  const candidate = resolve(rootReal, ...segments)
  const checkWithin = (resolvedTarget: string): string => {
    const rel = relative(rootReal, resolvedTarget)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw rpcError('PATH_OUTSIDE_WORKSPACE', 'Resolved path escapes the session workspace')
    }
    return rel.split(sep).join('/')
  }
  try {
    const targetReal = await realpath(candidate)
    const relativePosix = checkWithin(targetReal)
    return { rootReal, targetReal, relativePosix }
  } catch (error) {
    if (!options?.allowNonExistentLeaf) throw error
    const parent = resolve(candidate, '..')
    const parentReal = await realpath(parent)
    checkWithin(parentReal)
    const leaf = basename(candidate)
    if (!leaf || leaf === '.' || leaf === '..') {
      throw rpcError('INVALID_PATH', 'Invalid destination filename')
    }
    const targetReal = resolve(parentReal, leaf)
    const relativePosix = checkWithin(targetReal)
    return { rootReal, targetReal, relativePosix }
  }
}

/** Build a structured diff/command preview for remote approval cards from tool name + args. */
export function buildDiffPreview(toolName: string, args: unknown): RemoteDiffPreview | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  const lower = toolName.toLowerCase()

  const command = typeof record.command === 'string'
    ? record.command
    : typeof record.cmd === 'string'
      ? record.cmd
      : typeof record.script === 'string'
        ? record.script
        : undefined
  if (command && /(bash|shell|pwsh|powershell|terminal|exec|command|run)/u.test(lower)) {
    return { kind: 'command', command: truncateText(command, 8_192).text }
  }

  const filePath = typeof record.path === 'string'
    ? record.path
    : typeof record.file_path === 'string'
      ? record.file_path
      : typeof record.filePath === 'string'
        ? record.filePath
        : typeof record.target === 'string'
          ? record.target
          : undefined

  const oldText = typeof record.old_str === 'string'
    ? record.old_str
    : typeof record.old_text === 'string'
      ? record.old_text
      : typeof record.oldText === 'string'
        ? record.oldText
        : typeof record.old_string === 'string'
          ? record.old_string
          : undefined
  const newText = typeof record.new_str === 'string'
    ? record.new_str
    : typeof record.new_text === 'string'
      ? record.new_text
      : typeof record.newText === 'string'
        ? record.newText
        : typeof record.new_string === 'string'
          ? record.new_string
          : undefined
  if (oldText !== undefined && newText !== undefined) {
    return {
      kind: 'edit',
      ...(filePath ? { path: filePath } : {}),
      replacements: [{
        oldText: truncateText(oldText, 4_096).text,
        newText: truncateText(newText, 4_096).text,
      }],
    }
  }

  if (Array.isArray(record.edits) || Array.isArray(record.replacements)) {
    const rawList = (Array.isArray(record.edits) ? record.edits : record.replacements) as unknown[]
    const replacements: { oldText: string; newText: string }[] = []
    for (const item of rawList.slice(0, 12)) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      const o = typeof entry.oldText === 'string' ? entry.oldText
        : typeof entry.old_str === 'string' ? entry.old_str
          : typeof entry.old_text === 'string' ? entry.old_text
            : undefined
      const n = typeof entry.newText === 'string' ? entry.newText
        : typeof entry.new_str === 'string' ? entry.new_str
          : typeof entry.new_text === 'string' ? entry.new_text
            : undefined
      if (o !== undefined && n !== undefined) {
        replacements.push({ oldText: truncateText(o, 2_048).text, newText: truncateText(n, 2_048).text })
      }
    }
    if (replacements.length > 0) {
      return { kind: 'edit', ...(filePath ? { path: filePath } : {}), replacements }
    }
  }

  const content = typeof record.content === 'string'
    ? record.content
    : typeof record.file_text === 'string'
      ? record.file_text
      : typeof record.text === 'string'
        ? record.text
        : undefined
  if (filePath && content !== undefined && /(write|create|save|file|str_replace)/u.test(lower)) {
    return { kind: 'write', path: filePath, content: truncateText(content, 8_192).text }
  }

  return undefined
}

/**
 * Convert a validated `nimi.home-chat.v1` payload into a contiguous DSH seed log
 * with an empty system head at surface node 0 so a resumed Agent can replace it cleanly.
 */
export function buildHomeChatSeedEvents(
  payload: NimiHomeChatPayload,
  createId: () => string = randomUUID,
): { readonly createdAt: number; readonly events: readonly SessionEvent[] } {
  const events: SessionEvent[] = []
  let seq = 0
  let time = payload.messages[0]?.timestamp ?? Date.now()
  const push = (event: HomeChatSeedEvent, at?: number): SessionSeq => {
    if (typeof at === 'number' && Number.isFinite(at) && at > 0) time = Math.max(time, Math.trunc(at))
    const current = brandNumber<SessionSeq>(seq++)
    events.push({ ...event, seq: current, time })
    return current
  }

  const normalizedMessages = [...payload.messages]
  let turn = 0
  let index = 0
  for (let msg = normalizedMessages[0]; msg !== undefined; msg = normalizedMessages[index]) {
    turn += 1
    push({ type: 'turn/start', data: { turn } }, msg.timestamp)
    push({ type: 'step/start', data: { turn, step: 1 } }, msg.timestamp)
    if (turn === 1) {
      const head: SystemMessage = {
        id: brandString<MessageId>(createId()),
        role: 'system',
        content: [],
        source: { kind: 'system-prompt' },
      }
      push({ type: 'system/message', data: { turn, step: 1, message: head }, surfaceOp: 'append' })
    }
    if (msg.role === 'user') {
      const userMsg: UserMessage = {
        id: brandString<MessageId>(createId()),
        role: 'user',
        content: [{ type: 'text', text: msg.text }],
        source: { kind: 'user' },
      }
      push({ type: 'user/message', data: userMsg, surfaceOp: 'append' }, msg.timestamp)
      index += 1
      const next = normalizedMessages[index]
      if (next && next.role === 'assistant') {
        const assistantMsg: AssistantMessage = {
          id: brandString<MessageId>(createId()),
          role: 'assistant',
          content: [{ type: 'text', text: next.text }],
          source: { kind: 'model', provider: 'nimi', model: 'configured' },
        }
        push({
          type: 'assistant/message',
          data: { turn, step: 1, message: assistantMsg, stream: [] },
          surfaceOp: 'append',
        }, next.timestamp)
        index += 1
      }
    } else {
      // Leading or consecutive assistant message without a preceding user turn.
      const assistantMsg: AssistantMessage = {
        id: brandString<MessageId>(createId()),
        role: 'assistant',
        content: [{ type: 'text', text: msg.text }],
        source: { kind: 'model', provider: 'nimi', model: 'configured' },
      }
      push({
        type: 'assistant/message',
        data: { turn, step: 1, message: assistantMsg, stream: [] },
        surfaceOp: 'append',
      }, msg.timestamp)
      index += 1
    }
    push({ type: 'step/end', data: { turn, step: 1 } })
    push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }

  const trimmedTitle = payload.title.trim()
  if (trimmedTitle) {
    push({
      type: 'session/title',
      data: { title: trimmedTitle.slice(0, 120), messageSeqs: [], source: { kind: 'user' } },
    })
  }

  return { createdAt: events[0]?.time ?? Date.now(), events }
}

/** Default Worker -> Host IPC client over Node child-process messaging. */
export function createProcessNimiEcosystemClient(): NimiEcosystemClient {
  const pending = new Map<string, {
    resolve(value: Record<string, unknown>): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
  }>()

  const onMessage = (message: unknown): void => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if ((message as { type?: unknown }).type !== 'nimi-ecosystem-reply') return
    const reply = message as Record<string, unknown>
    if (typeof reply.id !== 'string') return
    const waiter = pending.get(reply.id)
    if (!waiter) return
    pending.delete(reply.id)
    clearTimeout(waiter.timer)
    if (reply.error !== undefined) {
      const errObj = reply.error as { message?: unknown; reasonCode?: unknown } | string
      const msg = typeof errObj === 'string'
        ? errObj
        : typeof errObj?.message === 'string' && errObj.message
          ? errObj.message
          : typeof errObj?.reasonCode === 'string'
            ? errObj.reasonCode
            : 'Nimi ecosystem request failed'
      waiter.reject(new Error(msg))
    } else {
      waiter.resolve(reply)
    }
  }
  process.on('message', onMessage)

  const request = (
    operation: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_ECOSYSTEM_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> => new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new Error('Request aborted'))
      return
    }
    if (!process.connected || process.send === undefined) {
      rejectPromise(new Error('Desktop Host IPC channel is disconnected'))
      return
    }
    const id = randomUUID()
    const onAbort = (): void => {
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      clearTimeout(entry.timer)
      rejectPromise(new Error('Request aborted'))
    }
    const timer = setTimeout(() => {
      pending.delete(id)
      signal?.removeEventListener('abort', onAbort)
      rejectPromise(new Error(`Nimi ecosystem "${operation}" timed out`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (value) => {
        signal?.removeEventListener('abort', onAbort)
        resolvePromise(value)
      },
      reject: (error) => {
        signal?.removeEventListener('abort', onAbort)
        rejectPromise(error)
      },
      timer,
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    process.send({ type: 'nimi-ecosystem', id, operation, ...payload }, (error) => {
      if (error !== null) {
        const entry = pending.get(id)
        if (!entry) return
        pending.delete(id)
        clearTimeout(entry.timer)
        signal?.removeEventListener('abort', onAbort)
        rejectPromise(error)
      }
    })
  })

  return {
    listIntegrations: async (signal) => {
      const res = await request('integration-list', {}, signal)
      return (Array.isArray(res.targets) ? res.targets : []) as readonly NimiWorkerIntegrationTarget[]
    },
    invokeIntegration: async (input, signal) => {
      const res = await request('integration-invoke', {
        targetRef: input.targetRef,
        operationName: input.operation,
        inputJson: input.inputJson,
      }, signal, Math.max(DEFAULT_ECOSYSTEM_TIMEOUT_MS, (input.timeoutMs ?? 0) + 10_000))
      return res.call as NimiWorkerIntegrationInvokeResult
    },
    getIntegrationCall: async (callId, signal) => {
      const res = await request('integration-get-call', { callId }, signal)
      return res.call as NimiWorkerIntegrationInvokeResult
    },
    cancelIntegrationCall: async (callId, signal) => {
      const res = await request('integration-cancel-call', { callId }, signal)
      const call = res.call as { status?: string } | undefined
      return { canceled: call?.status === 'canceled' }
    },
    putActivity: async (input) => {
      await request('activity-put', {
        input: {
          key: input.objectRef,
          revision: input.revision,
          kind: input.attention ? 'todo' : 'activity',
          attention: input.attention,
          title: input.title,
          type: input.attention ? 'dsh.approval.pending' : 'dsh.turn.updated',
          occurredAt: new Date().toISOString(),
          objectRef: input.objectRef,
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.attention ? { todoState: 'open' } : { todoState: 'completed' }),
        },
      }, undefined, 15_000)
    },
    transcribeAudio: (input, signal) => transcribeNimiAudio({
      data: Buffer.from(input.audioBytesBase64, 'base64'),
      mimeType: input.mimeType,
      ...(input.language ? { language: input.language } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.configRef ? { configRef: input.configRef } : {}),
    }, signal),
  }
}

export interface InstalledNimiEcosystemPlugin {
  handleWorkerRpc(operation: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
  dispose(): void
}

export interface InstallNimiEcosystemOptions {
  readonly client?: NimiEcosystemClient
  readonly homeDir?: string
  readonly attachProcessRpc?: boolean
  /** Wait for remote resolution when local Desktop UI answerer returns `'unavailable'`. Defaults to `true`. */
  readonly waitForRemoteWhenLocalUnavailable?: boolean
}

export function installNimiEcosystemPlugin(
  ctx: Context,
  options: InstallNimiEcosystemOptions = {},
): InstalledNimiEcosystemPlugin {
  const client = options.client ?? createProcessNimiEcosystemClient()
  const homeDir = options.homeDir ?? process.env.DSH_HOME ?? process.cwd()
  const waitForRemoteWhenLocalUnavailable = options.waitForRemoteWhenLocalUnavailable ?? true
  const disposers: (() => void)[] = []

  // Cache last discovered catalog so pre-execute approval prompts show human-friendly labels & effect.
  let cachedCatalog: readonly NimiWorkerIntegrationTarget[] = []
  const recentCallArgs = new Map<string, { readonly name: string; readonly args: unknown; readonly at: number }>()
  const pendingDecisions = new Map<string, PendingDecisionRecord>()
  const activityRevisions = new Map<string, number>()
  const sessionTitles = new Map<string, string>()
  const liveStreamText = new Map<string, { text: string; activeTool?: string | undefined }>()
  const createdSessionsByRequestId = new Map<string, { readonly id: string; readonly title: string }>()
  const trackedRequests = new Map<string, TrackedRemoteRequest>() // key: `${sessionId}:${requestId}`
  const activeRequestBySession = new Map<string, string>()
  const attachmentPathByFileId = new Map<string, {
    readonly sessionId: string
    readonly ref: string
    readonly name: string
    readonly mediaType: string
  }>()
  let decisionRevisionCounter = 1

  const nextActivityRevision = (sessionId: string): number => {
    const rev = (activityRevisions.get(sessionId) ?? 0) + 1
    activityRevisions.set(sessionId, rev)
    return rev
  }

  const resolveTitle = (sessionId: string): string => sessionTitles.get(sessionId) ?? 'Nimi DSH Session'

  const publishActivity = (sessionId: string, title: string, summary: string, attention: boolean): void => {
    void client.putActivity({
      objectRef: `session:${sessionId}`,
      title,
      summary,
      attention,
      revision: nextActivityRevision(sessionId),
    }).catch(() => undefined)
  }

  const requestKey = (sessionId: string, requestId: string): string => `${sessionId}:${requestId}`

  const lookupOperationMeta = (targetRef: string, operationName: string) => {
    const target = cachedCatalog.find(t => t.targetRef === targetRef)
    const op = target?.operations.find(o => o.name === operationName)
    return { target, op }
  }

  const sessionWorkspace = async (sessionId: string): Promise<string | undefined> => {
    const id = SessionId(sessionId)
    const live = ctx.get('sessions')?.get(id)
    if (live) return live.header.cwd
    return (await ctx.get('sessionPersistence')?.stat(id))?.header.cwd
  }

  const requireRemoteWorkspace = async (sessionId: string): Promise<string> => {
    const cwd = await sessionWorkspace(sessionId)
    if (!cwd || resolve(cwd) === resolve(homeDir)) {
      throw rpcError('SESSION_WORKSPACE_UNAVAILABLE', 'This session has no workspace available for remote file access')
    }
    return cwd
  }

  const resolveAudioWorkspace = async (sessionId?: string): Promise<string> => {
    const cwd = sessionId ? await sessionWorkspace(sessionId) : undefined
    if (cwd) return cwd
    const workspaces = ctx.get('workspaceRegistry')?.list() ?? []
    if (workspaces[0]?.path) return workspaces[0].path
    return homeDir
  }

  // 1. Register Nimi Integration Consume & Audio Transcribe Tools
  const tools = ctx.get('tools') as {
    register(definition: {
      name: string
      description: string
      parameters: Record<string, unknown>
      output: {
        schema: Record<string, unknown>
        render(args: unknown, value: unknown): ContentBlock[]
      }
      isConcurrencySafe?(args: unknown): boolean
      execute(args: unknown, exec: { signal: AbortSignal; agent?: { id: SessionId } }): Promise<unknown>
    }): () => void
  } | undefined

  if (tools) {
    disposers.push(tools.register({
      name: 'find_nimi_integrations',
      description: 'Discover Nimi ecosystem integrations granted to this app by Nimi Home, including both read and write operations and their JSON schemas.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional keyword filter matching integration or operation names/descriptions.' },
          effect: { type: 'string', enum: ['all', 'read', 'write'], description: 'Filter operations by effect.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          required: ['targets', 'truncated'],
          properties: {
            targets: { type: 'array', items: { type: 'object' } },
            truncated: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: safeJsonStringify(value, MAX_RESULT_JSON_CHARS).text }],
      },
      isConcurrencySafe: () => true,
      execute: async (rawArgs, exec) => {
        const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as {
          readonly query?: string
          readonly effect?: 'all' | 'read' | 'write'
        }
        const catalog = (await client.listIntegrations(exec.signal))
          .filter(target => target.integrationId !== NIMI_DSH_SESSION_PROVIDER_ID)
        cachedCatalog = catalog
        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
        const effectFilter = args.effect === 'read' || args.effect === 'write' ? args.effect : 'all'

        const matched = catalog.map((target) => {
          const targetDisplay = typeof target.displayName === 'string' ? target.displayName : ''
          const targetId = typeof target.integrationId === 'string' ? target.integrationId : ''
          const targetSkill = typeof target.skill === 'string' ? target.skill : ''
          const ops = (Array.isArray(target.operations) ? target.operations : [])
            .filter(op => effectFilter === 'all' || op.effect === effectFilter)
            .filter(op => !query
              || targetDisplay.toLowerCase().includes(query)
              || targetId.toLowerCase().includes(query)
              || targetSkill.toLowerCase().includes(query)
              || (op.name ?? '').toLowerCase().includes(query)
              || (op.displayName ?? '').toLowerCase().includes(query)
              || (op.description ?? '').toLowerCase().includes(query))
            .slice(0, 40)
            .map(op => ({
              name: op.name,
              ...(op.displayName ? { displayName: op.displayName } : {}),
              description: typeof op.description === 'string' ? op.description : '',
              effect: op.effect,
              retryPolicy: op.retryPolicy,
              inputSchemaJson: truncateText(typeof op.inputSchemaJson === 'string' ? op.inputSchemaJson : '{}', MAX_SCHEMA_PREVIEW_CHARS).text,
              outputSchemaJson: truncateText(typeof op.outputSchemaJson === 'string' ? op.outputSchemaJson : '{}', MAX_SCHEMA_PREVIEW_CHARS).text,
            }))
          return {
            targetRef: target.targetRef,
            integrationId: targetId,
            displayName: targetDisplay,
            available: target.available,
            skill: truncateText(targetSkill, 512).text,
            operations: ops,
          }
        }).filter(target => target.operations.length > 0 || (!query && effectFilter === 'all'))

        const truncated = matched.length > 25
        return { targets: matched.slice(0, 25), truncated }
      },
    }))

    disposers.push(tools.register({
      name: 'invoke_nimi_integration',
      description: 'Invoke a permitted read or write operation on a Nimi ecosystem integration discovered via find_nimi_integrations. Requires user approval. If an uncertain/accepted/unconfirmed receipt is returned, do NOT blindly retry; call check_nimi_integration_receipt with the returned callId.',
      parameters: {
        type: 'object',
        required: ['targetRef', 'operation'],
        properties: {
          targetRef: { type: 'string', minLength: 1, description: 'Target reference from find_nimi_integrations.' },
          operation: { type: 'string', minLength: 1, description: 'Operation name declared by the target.' },
          argumentsJson: { type: 'string', description: 'JSON object string matching the operation input schema.' },
          arguments: { type: 'object', description: 'Optional JSON object matching the operation input schema (used if argumentsJson is omitted).' },
          idempotencyKey: { type: 'string', description: 'Optional idempotency key for retry-safe write operations.' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          required: ['status', 'callId', 'targetRef', 'operation'],
          properties: {
            status: { type: 'string' },
            callId: { type: 'string' },
            targetRef: { type: 'string' },
            operation: { type: 'string' },
            resultJson: { type: 'string' },
            truncated: { type: 'boolean' },
            errorCode: { type: 'string' },
            message: { type: 'string' },
            uncertainEffect: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: safeJsonStringify(value, MAX_RESULT_JSON_CHARS).text }],
      },
      execute: async (rawArgs, exec) => {
        const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as {
          readonly targetRef?: string
          readonly operation?: string
          readonly argumentsJson?: string
          readonly arguments?: Record<string, unknown>
          readonly idempotencyKey?: string
          readonly timeoutMs?: number
        }
        const targetRef = typeof args.targetRef === 'string' ? args.targetRef.trim() : ''
        const operation = typeof args.operation === 'string' ? args.operation.trim() : ''
        if (!targetRef || !operation) throw new Error('targetRef and operation are required')
        const inputJson = typeof args.argumentsJson === 'string' && args.argumentsJson.trim()
          ? args.argumentsJson
          : JSON.stringify(args.arguments ?? {})
        let result = await client.invokeIntegration({
          targetRef,
          operation,
          inputJson,
          ...(typeof args.idempotencyKey === 'string' && args.idempotencyKey.trim()
            ? { idempotencyKey: args.idempotencyKey.trim() }
            : {}),
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
        }, exec.signal)

        // Observe fast async calls (such as MCP tools) for up to 5s via read-only receipt checks; never resubmit.
        const observeDeadline = Date.now() + 5_000
        while (result.status === 'accepted' && result.callId && Date.now() < observeDeadline) {
          if (exec.signal?.aborted) break
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 350)
            const onAbort = () => { clearTimeout(timer); resolve() }
            exec.signal?.addEventListener('abort', onAbort, { once: true })
          })
          if (exec.signal?.aborted) break
          try {
            result = await client.getIntegrationCall(result.callId, exec.signal)
          } catch {
            // Preserve the admitted receipt honestly if status observation transiently fails.
            break
          }
        }

        const uncertain = result.uncertainEffect === true
          || result.status === 'accepted'
          || result.status === 'unconfirmed'
        const boundedResult = typeof result.resultJson === 'string'
          ? truncateText(result.resultJson, MAX_RESULT_JSON_CHARS)
          : undefined

        return {
          status: result.status,
          callId: result.callId,
          targetRef,
          operation,
          ...(boundedResult ? { resultJson: boundedResult.text, ...(boundedResult.truncated ? { truncated: true } : {}) } : {}),
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
          ...(uncertain ? {
            uncertainEffect: true,
            message: result.message
              ?? 'Integration call effect is unconfirmed. Do NOT blindly retry; call check_nimi_integration_receipt with this callId to observe final status.',
          } : result.message ? { message: result.message } : {}),
        }
      },
    }))

    disposers.push(tools.register({
      name: 'check_nimi_integration_receipt',
      description: 'Read-only status check for a previously issued Nimi integration callId receipt (use when invoke_nimi_integration returned accepted or unconfirmed).',
      parameters: {
        type: 'object',
        required: ['callId'],
        properties: {
          callId: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          required: ['callId', 'status'],
          properties: {
            callId: { type: 'string' },
            status: { type: 'string' },
            resultJson: { type: 'string' },
            truncated: { type: 'boolean' },
            errorCode: { type: 'string' },
            message: { type: 'string' },
            uncertainEffect: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: safeJsonStringify(value, MAX_RESULT_JSON_CHARS).text }],
      },
      isConcurrencySafe: () => true,
      execute: async (rawArgs, exec) => {
        const callId = typeof (rawArgs as { callId?: unknown } | null)?.callId === 'string'
          ? (rawArgs as { callId: string }).callId.trim()
          : ''
        if (!callId) throw new Error('callId is required')
        const receipt = await client.getIntegrationCall(callId, exec.signal)
        const boundedResult = typeof receipt.resultJson === 'string'
          ? truncateText(receipt.resultJson, MAX_RESULT_JSON_CHARS)
          : undefined
        return {
          callId: receipt.callId || callId,
          status: receipt.status,
          ...(boundedResult ? { resultJson: boundedResult.text, ...(boundedResult.truncated ? { truncated: true } : {}) } : {}),
          ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
          ...(receipt.message ? { message: receipt.message } : {}),
          ...(receipt.uncertainEffect ? { uncertainEffect: true } : {}),
        }
      },
    }))

    disposers.push(tools.register({
      name: 'nimi_transcribe_audio',
      description: 'Transcribe a workspace audio file using the Nimi Runtime audio.transcribe capability.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1, description: 'Workspace-relative path to the audio file (<= 25 MiB).' },
          language: { type: 'string', description: 'Optional BCP-47 language hint (e.g. en, zh).' },
          prompt: { type: 'string', description: 'Optional vocabulary or transcription guidance.' },
          configRef: { type: 'string', description: 'Optional Nimi AI config ref to use for transcription.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          required: ['text', 'path', 'mimeType', 'bytes'],
          properties: {
            text: { type: 'string' },
            path: { type: 'string' },
            mimeType: { type: 'string' },
            bytes: { type: 'integer' },
          },
        },
        render: (_args, value) => {
          const rec = value as { text?: string; path?: string }
          return [{ type: 'text', text: rec.text ?? '' }]
        },
      },
      isConcurrencySafe: () => true,
      execute: async (rawArgs, exec) => {
        const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as {
          readonly path?: string
          readonly language?: string
          readonly prompt?: string
          readonly configRef?: string
        }
        const relPath = typeof args.path === 'string' ? args.path.trim() : ''
        if (!relPath) throw new Error('path is required')
        const workspaceRoot = await resolveAudioWorkspace(exec.agent ? String(exec.agent.id) : undefined)
        const { targetReal, relativePosix } = await resolveContainedWorkspacePath(workspaceRoot, relPath)
        const info = await stat(targetReal)
        if (!info.isFile()) throw new Error('Audio path must be a regular file')
        if (info.size > MAX_AUDIO_BYTES) throw new Error('Audio file exceeds 25 MiB limit')
        const mimeType = guessAudioMimeType(targetReal) ?? 'audio/mpeg'
        const bytes = await readFile(targetReal)
        const explicitConfigRef = typeof args.configRef === 'string' && args.configRef.trim() ? args.configRef.trim() : undefined
        const agent = exec.agent as { model?: { current?: () => { provider?: string; model?: string } | undefined } } | undefined
        const currentModel = agent?.model?.current?.()
        let sessionConfigRef: string | undefined
        if (currentModel?.provider === 'nimi' && typeof currentModel.model === 'string' && currentModel.model.startsWith('config.')) {
          const rest = currentModel.model.slice('config.'.length)
          const dot = rest.indexOf('.')
          sessionConfigRef = (dot > 0 ? rest.slice(0, dot) : rest).trim() || undefined
        }
        const resolvedConfigRef = explicitConfigRef ?? sessionConfigRef
        const result = await client.transcribeAudio({
          audioBytesBase64: bytes.toString('base64'),
          mimeType,
          ...(typeof args.language === 'string' && args.language.trim() ? { language: args.language.trim() } : {}),
          ...(typeof args.prompt === 'string' && args.prompt.trim() ? { prompt: args.prompt.trim() } : {}),
          ...(resolvedConfigRef ? { configRef: resolvedConfigRef } : {}),
        }, exec.signal)
        return { text: result.text, path: relativePosix, mimeType, bytes: bytes.byteLength }
      },
    }))
  }

  // 2. Pre-execute observer: capture tool arguments for diff previews & gate `invoke_nimi_integration` behind approval
  const onAny = ctx.on.bind(ctx) as <Args extends unknown[], Result>(
    event: string,
    listener: (...args: Args) => Result,
    options?: { readonly prepend?: boolean },
  ) => () => void

  disposers.push(onAny('tools/pre-execute', async (
    exec: { readonly callId: ToolCallId; readonly name: string; readonly arguments: unknown },
    next: () => Promise<unknown>,
  ) => {
    recentCallArgs.set(String(exec.callId), { name: exec.name, args: exec.arguments, at: Date.now() })
    if (recentCallArgs.size > 200) {
      const oldest = recentCallArgs.keys().next().value
      if (oldest !== undefined) recentCallArgs.delete(oldest)
    }
    if (exec.name === 'invoke_nimi_integration') {
      const args = (typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {}) as {
        readonly targetRef?: string
        readonly operation?: string
        readonly argumentsJson?: string
        readonly arguments?: unknown
      }
      const targetRef = typeof args.targetRef === 'string' ? args.targetRef : ''
      const opName = typeof args.operation === 'string' ? args.operation : ''
      const { target, op } = lookupOperationMeta(targetRef, opName)
      const targetLabel = target?.displayName ?? targetRef
      const opLabel = op?.displayName ? `${op.displayName} (${opName})` : opName
      const effectLabel = op?.effect ?? 'external'
      const preview = truncateText(
        typeof args.argumentsJson === 'string' ? args.argumentsJson : JSON.stringify(args.arguments ?? {}),
        240,
      ).text
      return {
        kind: 'ask',
        reason: `Invoke Nimi integration "${targetLabel}" operation "${opLabel}" [${effectLabel}] with ${preview}`,
        displayReason: {
          en: `Approve Nimi integration (${effectLabel}): ${targetLabel} → ${opLabel}\nArguments: ${preview}`,
          zh: `确认调用 Nimi 集成（${effectLabel}）：${targetLabel} → ${opLabel}\n参数：${preview}`,
        },
      }
    }
    return next()
  }, { prepend: true }))

  // 3. Dual-channel approval waterfall interceptor (Desktop UI + Remote Companion)
  disposers.push(onAny('approval/request', async (
    req: {
      readonly agent: { readonly id: SessionId; inject?(msg: UserMessage): void; send?(msg: UserMessage, target: 'next-step', wakeup: boolean): void }
      readonly toolName: string
      readonly callId?: ToolCallId
      readonly reason?: string
      readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
      readonly signal?: AbortSignal
    },
    next: () => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>,
  ) => {
    const sessionId = String(req.agent.id)
    const callKey = req.callId ? String(req.callId) : undefined
    const captured = callKey ? recentCallArgs.get(callKey) : undefined
    const taskId = callKey ?? randomUUID()
    const revision = decisionRevisionCounter++
    const argumentsJson = safeJsonStringify(captured?.args ?? {}, MAX_ARGUMENTS_JSON_CHARS).text
    const diffPreview = buildDiffPreview(req.toolName, captured?.args)

    let resolveRemotePromise!: (result: { readonly outcome: 'allowed-once' | 'rejected'; readonly feedback?: string }) => void
    const remotePromise = new Promise<{ readonly outcome: 'allowed-once' | 'rejected'; readonly feedback?: string }>((resolve) => {
      resolveRemotePromise = resolve
    })

    const record: PendingDecisionRecord = {
      sessionId,
      taskId,
      revision,
      tool: req.toolName,
      title: `Approve ${req.toolName}`,
      summary: req.displayReason?.en ?? req.reason ?? `Approve tool "${req.toolName}"`,
      argumentsJson,
      ...(diffPreview ? { diffPreview } : {}),
      settled: false,
      resolveRemote(outcome, feedback) {
        if (record.settled) return
        record.settled = true
        resolveRemotePromise({ outcome, ...(feedback ? { feedback } : {}) })
      },
    }
    pendingDecisions.set(sessionId, record)

    try {
      const localPromise = Promise.resolve().then(() => next()).catch((): 'unavailable' => 'unavailable')
      const signal = req.signal
      const abortPromise = signal
        ? new Promise<'cancelled'>((resolve) => {
          if (signal.aborted) { resolve('cancelled'); return }
          signal.addEventListener('abort', () => { resolve('cancelled') }, { once: true })
        })
        : null

      const first = await Promise.race([
        localPromise.then(outcome => ({ source: 'local' as const, outcome })),
        remotePromise.then(result => ({ source: 'remote' as const, ...result })),
        ...(abortPromise ? [abortPromise.then(outcome => ({ source: 'abort' as const, outcome }))] : []),
      ])

      if (first.source === 'remote') {
        if (first.feedback && first.feedback.trim()) {
          const note = createUserMessage({
            content: [{
              type: 'text',
              text: `[Reviewer feedback on "${req.toolName}" (${first.outcome === 'allowed-once' ? 'approved' : 'denied'})]: ${first.feedback.trim()}`,
            }],
            source: { kind: 'user' },
          })
          if (typeof req.agent.inject === 'function') req.agent.inject(note)
          else if (typeof req.agent.send === 'function') req.agent.send(note, 'next-step', false)
        }
        return first.outcome
      }
      if (first.source === 'abort') return 'cancelled'
      if (first.outcome !== 'unavailable') return first.outcome
      if (!waitForRemoteWhenLocalUnavailable) return 'unavailable'

      // Desktop UI is not attached (headless/background) — hold open for Remote Companion until resolved or aborted.
      const waited = await Promise.race([
        remotePromise.then(result => ({ source: 'remote' as const, ...result })),
        ...(abortPromise ? [abortPromise.then(outcome => ({ source: 'abort' as const, outcome }))] : []),
      ])
      if (waited.source === 'abort') return 'cancelled'
      if (waited.feedback && waited.feedback.trim()) {
        const note = createUserMessage({
          content: [{
            type: 'text',
            text: `[Reviewer feedback on "${req.toolName}" (${waited.outcome === 'allowed-once' ? 'approved' : 'denied'})]: ${waited.feedback.trim()}`,
          }],
          source: { kind: 'user' },
        })
        if (typeof req.agent.inject === 'function') req.agent.inject(note)
        else if (typeof req.agent.send === 'function') req.agent.send(note, 'next-step', false)
      }
      return waited.outcome
    } finally {
      record.settled = true
      if (pendingDecisions.get(sessionId) === record) {
        pendingDecisions.delete(sessionId)
      }
    }
  }, { prepend: true }))

  // 4. Observe session & agent events for Automatic Home Activity and remote request tracking
  disposers.push(onAny('session/event', (session: { id: SessionId; header?: { origin?: string } }, event: SessionEvent) => {
    if (session.header?.origin === 'subagent') return
    const sessionId = String(session.id)
    const eventType: string = event.type
    const eventData: unknown = event.data

    if (eventType === 'session/title') {
      const title = (eventData as { title?: unknown }).title
      if (typeof title === 'string' && title.trim()) sessionTitles.set(sessionId, title.trim())
      return
    }
    if (event.type === 'user/message') {
      const rpcId = (event.data.source as { rpcId?: unknown } | undefined)?.rpcId
      if (typeof rpcId === 'string') {
        const tracked = trackedRequests.get(requestKey(sessionId, rpcId))
        if (tracked && tracked.status === 'queued') tracked.status = 'placed'
        activeRequestBySession.set(sessionId, rpcId)
      }
      return
    }
    if (event.type === 'tool/call') {
      const state = liveStreamText.get(sessionId) ?? { text: '' }
      state.activeTool = event.data.name
      liveStreamText.set(sessionId, state)
      return
    }
    if (event.type === 'tool/result') {
      const state = liveStreamText.get(sessionId)
      if (state) state.activeTool = undefined
      return
    }
    if (event.type === 'assistant/message') {
      const text = extractTextFromBlocks(event.data.message.content)
      liveStreamText.set(sessionId, { text, activeTool: undefined })
      const activeReqId = activeRequestBySession.get(sessionId)
      if (activeReqId) {
        const tracked = trackedRequests.get(requestKey(sessionId, activeReqId))
        if (tracked) {
          const combined = tracked.answerText ? `${tracked.answerText}\n\n${text}` : text
          const bounded = truncateText(combined, MAX_ANSWER_CHARS)
          tracked.answerText = bounded.text
          tracked.truncated = tracked.truncated || bounded.truncated
        }
      }
      return
    }
    if (eventType === 'approval/asked') {
      const data = eventData as { toolName: string; reason?: string }
      const title = resolveTitle(sessionId)
      publishActivity(
        sessionId,
        `Approval needed: ${title}`,
        data.reason ? `${data.toolName}: ${data.reason}` : `Waiting for approval to run ${data.toolName}`,
        true,
      )
      return
    }
    if (eventType === 'approval/decided') {
      const data = eventData as { outcome: string }
      publishActivity(sessionId, resolveTitle(sessionId), `Approval ${data.outcome}`, false)
      return
    }
    if (event.type === 'turn/end') {
      const activeReqId = activeRequestBySession.get(sessionId)
      if (activeReqId) {
        const tracked = trackedRequests.get(requestKey(sessionId, activeReqId))
        if (tracked && (tracked.status === 'queued' || tracked.status === 'placed')) {
          tracked.status = event.data.reason.kind === 'completed' || event.data.reason.kind === 'max-tokens'
            ? 'done'
            : 'unanswered'
        }
        activeRequestBySession.delete(sessionId)
      }
      liveStreamText.delete(sessionId)
      const reason = event.data.reason
      const summary = reason.kind === 'error'
        ? `Failed: ${reason.error.message}`
        : reason.kind === 'aborted'
          ? 'Turn stopped'
          : 'Turn completed'
      publishActivity(sessionId, resolveTitle(sessionId), summary, false)
    }
  }))

  disposers.push(onAny('agent/stream', (payload: {
    readonly agent?: { readonly id: SessionId; readonly session?: { readonly header?: { readonly origin?: string } } }
    readonly frame?: { readonly type: string; readonly chunk?: { readonly type: string; readonly text?: string } }
  }) => {
    const agent = payload.agent
    if (!agent || agent.session?.header?.origin === 'subagent') return
    const sessionId = String(agent.id)
    const frame = payload.frame
    if (!frame) return
    if (frame.type === 'start') {
      liveStreamText.set(sessionId, { text: '' })
    } else if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta' && typeof frame.chunk.text === 'string') {
      const current = liveStreamText.get(sessionId) ?? { text: '' }
      current.text = truncateText(current.text + frame.chunk.text, MAX_PROGRESS_TEXT_CHARS).text
      liveStreamText.set(sessionId, current)
    }
  }))

  disposers.push(onAny('agent/error', (payload: {
    readonly agent?: { readonly id: SessionId; readonly session?: { readonly header?: { readonly origin?: string } } }
    readonly error?: unknown
  }) => {
    const agent = payload.agent
    if (!agent || agent.session?.header?.origin === 'subagent') return
    const sessionId = String(agent.id)
    const message = payload.error instanceof Error ? payload.error.message : String(payload.error ?? 'Unknown error')
    publishActivity(sessionId, resolveTitle(sessionId), `Error: ${message}`, false)
  }))

  // Helper: cold-read a session's event log without ever opening an Agent or model!
  const readColdOrLiveEvents = async (sessionId: string): Promise<{
    readonly header: SessionHeader
    readonly events: readonly SessionEvent[]
  } | undefined> => {
    const sid = SessionId(sessionId)
    const live = ctx.get('sessions')?.get(sid)
    if (live) return { header: live.header, events: live.snapshotEvents() }
    const query = ctx.get('sessionQuery') as {
      readSession(id: SessionId): Promise<{ readonly session: SessionHeader; readonly events: readonly SessionEvent[] }>
    } | undefined
    if (query) {
      try {
        const snapshot = await query.readSession(sid)
        return { header: snapshot.session, events: snapshot.events }
      } catch {
        return undefined
      }
    }
    return undefined
  }

  const scanRequestFromEvents = (events: readonly SessionEvent[], reqId: string): {
    readonly status: 'not-found' | 'queued' | 'placed' | 'done' | 'unanswered'
    readonly text?: string
    readonly truncated?: boolean
  } => {
    let placed = false
    const answers: string[] = []
    for (const ev of events) {
      if (!placed) {
        placed = ev.type === 'user/message' && 'rpcId' in ev.data.source && ev.data.source.rpcId === reqId
        continue
      }
      if (ev.type === 'assistant/message') {
        const t = extractTextFromBlocks(ev.data.message.content)
        if (t) answers.push(t)
      } else if (ev.type === 'turn/end') {
        const joined = answers.join('\n\n')
        const bounded = truncateText(joined, MAX_ANSWER_CHARS)
        const ok = ev.data.reason.kind === 'completed' || ev.data.reason.kind === 'max-tokens'
        return {
          status: ok ? 'done' : 'unanswered',
          ...(bounded.text ? { text: bounded.text } : {}),
          ...(bounded.truncated ? { truncated: true } : {}),
        }
      }
    }
    if (!placed) return { status: 'not-found' }
    const joined = answers.join('\n\n')
    const bounded = truncateText(joined, MAX_ANSWER_CHARS)
    return {
      status: 'placed',
      ...(bounded.text ? { text: bounded.text } : {}),
      ...(bounded.truncated ? { truncated: true } : {}),
    }
  }

  const readImportIndex = async (): Promise<Record<string, ImportedHomeChatRecord>> => {
    try {
      const raw = await readFile(join(homeDir, 'nimi-home-chat-imports.json'), 'utf8')
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, ImportedHomeChatRecord>
        : {}
    } catch {
      return {}
    }
  }

  const writeImportIndex = async (index: Record<string, ImportedHomeChatRecord>): Promise<void> => {
    await mkdir(homeDir, { recursive: true })
    await writeFile(join(homeDir, 'nimi-home-chat-imports.json'), JSON.stringify(index, null, 2), 'utf8')
  }

  // 5. Worker RPC dispatcher for `ai.nimi.dsh.sessions` & `nimi.home-chat.v1`
  const handleWorkerRpc = async (
    operation: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const input = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
    const sessionController = ctx.get('sessionController') as {
      list(req: object, sig: AbortSignal): Promise<{ readonly items: readonly {
        readonly sessionId: SessionId
        readonly updatedAt: number
        readonly running: boolean
        readonly origin?: 'subagent'
        readonly cwd?: string
        readonly projections?: { readonly values?: { readonly title?: { readonly title?: string } } }
      }[] }>
      create(req: { readonly workspaceId?: unknown; readonly cwd?: string }): Promise<{ readonly sessionId: SessionId }>
      selectModel(req: { readonly sessionId: SessionId; readonly provider: string; readonly model: string }): Promise<unknown>
      prompt(req: {
        readonly requestId: unknown
        readonly sessionId: SessionId
        readonly mode: 'queue' | 'steer'
        readonly content: readonly { readonly type: 'text'; readonly text: string }[]
      }, sig: AbortSignal): Promise<{ readonly accepted: true }>
      cancel(req: { readonly sessionId: SessionId }): { readonly accepted: true }
    } | undefined

    const effectiveSignal = signal ?? new AbortController().signal

    switch (operation) {
      case 'remote.session.list': {
        const offset = typeof input.offset === 'number' && input.offset >= 0 ? input.offset : 0
        let rows: {
          readonly id: string
          readonly title: string
          readonly status: 'idle' | 'running' | 'waiting' | 'error'
          readonly hasPendingDecision: boolean
          readonly workspaceLabel?: string
          readonly updatedAt?: number
        }[] = []

        if (sessionController) {
          const list = await sessionController.list({}, effectiveSignal)
          rows = list.items
            .filter(item => item.origin !== 'subagent')
            .map((item) => {
              const id = String(item.sessionId)
              const hasPending = pendingDecisions.has(id)
              const title = item.projections?.values?.title?.title
                ?? sessionTitles.get(id)
                ?? 'New Session'
              if (title && title !== 'New Session') sessionTitles.set(id, title)
              return {
                id,
                title,
                status: hasPending ? 'waiting' as const : item.running ? 'running' as const : 'idle' as const,
                hasPendingDecision: hasPending,
                ...(item.cwd ? { workspaceLabel: basename(item.cwd) || item.cwd } : {}),
                updatedAt: item.updatedAt,
              }
            })
        } else {
          const sessions = ctx.get('sessions')?.list() ?? []
          rows = sessions
            .filter(session => session.header.origin !== 'subagent')
            .map((session) => {
              const id = String(session.id)
              const hasPending = pendingDecisions.has(id)
              const agent = ctx.get('agents')?.get(session.id)
              return {
                id,
                title: resolveTitle(id),
                status: hasPending ? 'waiting' as const : agent?.status === 'running' ? 'running' as const : 'idle' as const,
                hasPendingDecision: hasPending,
                ...(session.header.cwd ? { workspaceLabel: basename(session.header.cwd) || session.header.cwd } : {}),
                updatedAt: session.header.createdAt,
              }
            })
        }

        const slice = rows.slice(offset, offset + SESSION_LIST_PAGE_SIZE)
        const nextOffset = offset + slice.length < rows.length ? offset + slice.length : null
        return { sessions: slice, nextOffset }
      }

      case 'remote.session.getHistory': {
        const sessionId = String(input.sessionId ?? '')
        const cursor = typeof input.cursor === 'number' && input.cursor >= 0 ? input.cursor : 0
        const limit = typeof input.limit === 'number' ? Math.min(50, Math.max(1, input.limit)) : 30
        const data = await readColdOrLiveEvents(sessionId)
        if (!data) throw rpcError('SESSION_NOT_FOUND', `Session "${sessionId}" not found`)
        const toolNameByCallId = new Map<string, string>()
        const entries: {
          readonly id: string
          readonly role: 'user' | 'assistant' | 'tool'
          readonly text: string
          readonly toolName?: string
          readonly toolFailure?: 'invalid-arguments' | 'blocked' | 'interrupted' | 'other'
          readonly truncated?: boolean
          readonly timestamp?: number
        }[] = []
        for (const ev of data.events) {
          if (ev.type === 'tool/call') {
            toolNameByCallId.set(String(ev.data.callId), ev.data.name)
          } else if (ev.type === 'user/message') {
            if (ev.data.source.kind !== 'user') continue
            const raw = extractTextFromBlocks(ev.data.content)
            if (!raw) continue
            const bounded = truncateText(raw, MAX_HISTORY_TEXT_CHARS)
            entries.push({
              id: `ev-${ev.seq}`,
              role: 'user',
              text: bounded.text,
              ...(bounded.truncated ? { truncated: true } : {}),
              timestamp: ev.time,
            })
          } else if (ev.type === 'assistant/message') {
            const raw = extractTextFromBlocks(ev.data.message.content)
            if (!raw) continue
            const bounded = truncateText(raw, MAX_HISTORY_TEXT_CHARS)
            entries.push({
              id: `ev-${ev.seq}`,
              role: 'assistant',
              text: bounded.text,
              ...(bounded.truncated ? { truncated: true } : {}),
              timestamp: ev.time,
            })
          } else if (ev.type === 'tool/result') {
            const raw = extractTextFromBlocks(ev.data.message.content)
            const bounded = truncateText(raw || '(empty tool output)', MAX_HISTORY_TEXT_CHARS)
            const toolName = toolNameByCallId.get(String(ev.data.message.toolCallId))
            entries.push({
              id: `ev-${ev.seq}`,
              role: 'tool',
              text: bounded.text,
              ...(toolName ? { toolName } : {}),
              ...(ev.data.message.isError ? { toolFailure: 'other' as const } : {}),
              ...(bounded.truncated ? { truncated: true } : {}),
              timestamp: ev.time,
            })
          }
        }
        const slice = entries.slice(cursor, cursor + limit)
        const nextCursor = cursor + slice.length < entries.length ? cursor + slice.length : null
        return { sessionId, entries: slice, nextCursor }
      }

      case 'remote.session.create': {
        const requestId = String(input.requestId ?? '')
        const existing = createdSessionsByRequestId.get(requestId)
        if (existing) return existing
        if (!sessionController) throw rpcError('UNAVAILABLE', 'Session controller is unavailable')
        const workspace = ctx.get('workspaceRegistry')?.list()[0]
        if (!workspace) throw rpcError('SESSION_WORKSPACE_UNAVAILABLE', 'Open Nimi DSH on the desktop and add a workspace first')
        const created = await sessionController.create({ workspaceId: workspace.id })
        const configRef = typeof input.configRef === 'string' && input.configRef.trim() ? input.configRef.trim() : undefined
        if (configRef) {
          const modelId = configRef === 'default' || configRef === 'configured'
            ? 'configured'
            : configRef.startsWith('config.') ? configRef : `config.${configRef}`
          await sessionController.selectModel({
            sessionId: created.sessionId,
            provider: 'nimi',
            model: modelId,
          }).catch(() => undefined)
        }
        const record = { id: String(created.sessionId), title: 'New Session' }
        createdSessionsByRequestId.set(requestId, record)
        return record
      }

      case 'remote.session.submit': {
        const sessionId = String(input.sessionId ?? '')
        const requestId = String(input.requestId ?? '')
        const text = String(input.text ?? '')
        const key = requestKey(sessionId, requestId)
        if (trackedRequests.has(key)) return { requestId }
        if (!sessionController) throw rpcError('UNAVAILABLE', 'Session controller is unavailable')
        trackedRequests.set(key, {
          sessionId,
          requestId,
          status: 'queued',
          answerText: '',
          truncated: false,
        })
        try {
          await sessionController.prompt({
            sessionId: SessionId(sessionId),
            requestId: brandString(requestId),
            mode: 'queue',
            content: [{ type: 'text', text }],
          }, effectiveSignal)
        } catch (error) {
          trackedRequests.delete(key)
          throw error
        }
        return { requestId }
      }

      case 'remote.session.inputStatus': {
        const sessionId = String(input.sessionId ?? '')
        const requestId = String(input.requestId ?? '')
        const tracked = trackedRequests.get(requestKey(sessionId, requestId))
        if (tracked) return { requestId, status: tracked.status }
        const data = await readColdOrLiveEvents(sessionId)
        if (!data) return { requestId, status: 'not-found' }
        const scanned = scanRequestFromEvents(data.events, requestId)
        return { requestId, status: scanned.status }
      }

      case 'remote.session.readAnswer': {
        const sessionId = String(input.sessionId ?? '')
        const requestId = String(input.requestId ?? '')
        const tracked = trackedRequests.get(requestKey(sessionId, requestId))
        if (tracked) {
          return {
            requestId,
            status: tracked.status,
            ...(tracked.answerText ? { text: tracked.answerText } : {}),
            ...(tracked.truncated ? { truncated: true } : {}),
          }
        }
        const data = await readColdOrLiveEvents(sessionId)
        if (!data) return { requestId, status: 'not-found' }
        return { requestId, ...scanRequestFromEvents(data.events, requestId) }
      }

      case 'remote.session.stopInput': {
        const sessionId = String(input.sessionId ?? '')
        const requestId = String(input.requestId ?? '')
        const tracked = trackedRequests.get(requestKey(sessionId, requestId))
        if (!tracked) {
          const data = await readColdOrLiveEvents(sessionId)
          const scanned = data ? scanRequestFromEvents(data.events, requestId) : { status: 'not-found' as const }
          if (scanned.status === 'not-found') return { requestId, outcome: 'not-found' }
          if (scanned.status === 'done' || scanned.status === 'unanswered') return { requestId, outcome: 'settled' }
        } else if (tracked.status === 'done' || tracked.status === 'unanswered') {
          return { requestId, outcome: 'settled' }
        }
        if (sessionController) {
          sessionController.cancel({ sessionId: SessionId(sessionId) })
          return { requestId, outcome: 'requested' }
        }
        return { requestId, outcome: 'check-again' }
      }

      case 'remote.session.observeProgress': {
        // STRICT COLD-READ INVARIANT: never call resolveAgent / resume / model APIs!
        const sessionId = String(input.sessionId ?? '')
        const sid = SessionId(sessionId)
        const pending = pendingDecisions.get(sessionId)
        const liveAgent = ctx.get('agents')?.get(sid)
        const liveSession = ctx.get('sessions')?.get(sid)
        const liveStream = liveStreamText.get(sessionId)

        let turn = 0
        let lastAssistantText = ''
        let lastTurnEndKind: string | undefined
        let openTurn = false

        if (liveSession) {
          const events = liveSession.snapshotEvents()
          for (const ev of events) {
            if (ev.type === 'turn/start') { turn = ev.data.turn; openTurn = true; lastTurnEndKind = undefined }
            else if (ev.type === 'turn/end') { openTurn = false; lastTurnEndKind = ev.data.reason.kind }
            else if (ev.type === 'assistant/message') { lastAssistantText = extractTextFromBlocks(ev.data.message.content) }
          }
        } else {
          const cold = await readColdOrLiveEvents(sessionId)
          if (!cold) throw rpcError('SESSION_NOT_FOUND', `Session "${sessionId}" not found`)
          for (const ev of cold.events) {
            if (ev.type === 'turn/start') { turn = ev.data.turn; openTurn = true; lastTurnEndKind = undefined }
            else if (ev.type === 'turn/end') { openTurn = false; lastTurnEndKind = ev.data.reason.kind }
            else if (ev.type === 'assistant/message') { lastAssistantText = extractTextFromBlocks(ev.data.message.content) }
          }
        }

        const stage: 'idle' | 'queued' | 'placed' | 'generating' | 'waiting' | 'tools' | 'done' | 'unanswered' = pending
          ? 'waiting'
          : liveStream?.activeTool
            ? 'tools'
            : liveAgent?.status === 'running' || openTurn
              ? (liveStream?.text ? 'generating' : 'placed')
              : lastTurnEndKind === 'completed' || lastTurnEndKind === 'max-tokens'
                ? 'done'
                : lastTurnEndKind === 'error' || lastTurnEndKind === 'aborted'
                  ? 'unanswered'
                  : 'idle'

        const rawText = liveStream?.text || lastAssistantText
        const bounded = truncateText(rawText, MAX_PROGRESS_TEXT_CHARS)
        return {
          stage,
          turn,
          text: bounded.text,
          truncated: bounded.truncated,
          ...(liveStream?.activeTool ? { activeTool: liveStream.activeTool } : {}),
          hasPendingDecision: Boolean(pending),
        }
      }

      case 'remote.session.reviewDecision': {
        const sessionId = String(input.sessionId ?? '')
        const pending = pendingDecisions.get(sessionId)
        if (!pending || pending.settled) return { state: 'none' }
        return {
          state: 'review',
          taskId: pending.taskId,
          revision: pending.revision,
          tool: pending.tool,
          title: pending.title,
          summary: pending.summary,
          argumentsJson: pending.argumentsJson,
          ...(pending.diffPreview ? { diffPreview: pending.diffPreview } : {}),
        }
      }

      case 'remote.session.resolveDecision': {
        const sessionId = String(input.sessionId ?? '')
        const taskId = String(input.taskId ?? '')
        const revision = Number(input.revision)
        const allow = Boolean(input.allow)
        const feedback = typeof input.feedback === 'string' ? input.feedback : undefined
        const pending = pendingDecisions.get(sessionId)
        if (!pending || pending.settled || pending.taskId !== taskId || pending.revision !== revision) {
          return { outcome: 'stale' }
        }
        pending.resolveRemote(allow ? 'allowed-once' : 'rejected', feedback)
        return { outcome: 'recorded' }
      }

      case 'remote.session.exists': {
        const sessionId = String(input.sessionId ?? '')
        const sid = SessionId(sessionId)
        if (ctx.get('sessions')?.get(sid)) return { exists: true }
        const st = await ctx.get('sessionPersistence')?.stat(sid).catch(() => undefined)
        return { exists: Boolean(st) }
      }

      case 'remote.session.checkAttachmentWorkspace': {
        await requireRemoteWorkspace(String(input.sessionId ?? ''))
        return undefined
      }

      case 'remote.session.listFiles': {
        const sessionId = String(input.sessionId ?? '')
        const folder = typeof input.folder === 'string' ? input.folder : ''
        const offset = typeof input.offset === 'number' && input.offset >= 0 ? input.offset : 0
        const workspaceRoot = await requireRemoteWorkspace(sessionId)
        const { targetReal, relativePosix } = await resolveContainedWorkspacePath(workspaceRoot, folder)
        const dirEntries = await readdir(targetReal, { withFileTypes: true })
        const items: { readonly name: string; readonly ref: string; readonly directory: boolean; readonly size?: number }[] = []
        for (const entry of dirEntries) {
          if (entry.name === '.git') continue
          const childRel = relativePosix ? `${relativePosix}/${entry.name}` : entry.name
          try {
            // Ensure symlink entries inside directory do not escape the workspace root.
            const childResolved = await resolveContainedWorkspacePath(workspaceRoot, childRel)
            const childStat = await stat(childResolved.targetReal)
            items.push({
              name: entry.name,
              ref: childResolved.relativePosix,
              directory: childStat.isDirectory(),
              ...(!childStat.isDirectory() ? { size: childStat.size } : {}),
            })
          } catch {
            // Skip broken or escaping symlinks fail-closed.
          }
        }
        items.sort((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1))
        const slice = items.slice(offset, offset + FILE_LIST_PAGE_SIZE)
        const nextOffset = offset + slice.length < items.length ? offset + slice.length : null
        return { items: slice, nextOffset }
      }

      case 'remote.session.materializeAttachment': {
        const sessionId = String(input.sessionId ?? '')
        const fileId = String(input.fileId ?? '')
        const mediaType = typeof input.mediaType === 'string' && input.mediaType ? input.mediaType : 'application/octet-stream'
        const dataBase64 = String(input.dataBase64 ?? '')
        const bytes = Buffer.from(dataBase64, 'base64')
        if (bytes.byteLength > MAX_REMOTE_FILE_BYTES) {
          throw rpcError('ASSET_TOO_LARGE', 'Attachment exceeds 32 MiB limit')
        }
        const workspaceRoot = await requireRemoteWorkspace(sessionId)
        const attachDirRel = '.nimi-attachments'
        const { targetReal: dirReal } = await resolveContainedWorkspacePath(workspaceRoot, attachDirRel, { allowNonExistentLeaf: true })
        await mkdir(dirReal, { recursive: true })
        const fileName = `${fileId}${extensionForMimeType(mediaType)}`
        const relFile = `${attachDirRel}/${fileName}`
        const { targetReal, relativePosix } = await resolveContainedWorkspacePath(workspaceRoot, relFile, { allowNonExistentLeaf: true })
        await writeFile(targetReal, bytes)
        attachmentPathByFileId.set(fileId, { sessionId, ref: relativePosix, name: fileName, mediaType })
        return { fileId, ref: relativePosix }
      }

      case 'remote.session.readFile': {
        const sessionId = String(input.sessionId ?? '')
        const fileIdInput = typeof input.fileId === 'string' && input.fileId.trim() ? input.fileId.trim() : undefined
        const refInput = typeof input.ref === 'string' && input.ref.trim() ? input.ref.trim() : undefined
        let ref = refInput
        const resolvedFileId = fileIdInput ?? randomUUID()
        if (!ref && fileIdInput) {
          const mapped = attachmentPathByFileId.get(fileIdInput)
          if (!mapped || mapped.sessionId !== sessionId) {
            throw rpcError('FILE_NOT_FOUND', `File "${fileIdInput}" not found in session`)
          }
          ref = mapped.ref
        }
        if (!ref) throw rpcError('INVALID_ARGUMENT', 'Either fileId or ref is required')
        const workspaceRoot = await requireRemoteWorkspace(sessionId)
        const { targetReal } = await resolveContainedWorkspacePath(workspaceRoot, ref)
        const info = await stat(targetReal)
        if (!info.isFile()) throw rpcError('INVALID_PATH', 'Requested path is not a regular file')
        if (info.size > MAX_REMOTE_FILE_BYTES) throw rpcError('ASSET_TOO_LARGE', 'File exceeds 32 MiB limit')
        const bytes = await readFile(targetReal)
        const name = basename(targetReal)
        const mediaType = guessMimeType(targetReal)
        attachmentPathByFileId.set(resolvedFileId, { sessionId, ref, name, mediaType })
        return {
          fileId: resolvedFileId,
          name,
          mediaType,
          sizeBytes: bytes.byteLength,
          dataBase64: bytes.toString('base64'),
        }
      }

      case 'nimi.importHomeChat': {
        const { format, title: suppliedTitle, messages, draft, digest } = input
        if (format !== 'nimi.home-chat.v1' || typeof suppliedTitle !== 'string'
          || !Array.isArray(messages) || !messages.every(isHomeChatMessage)
          || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)
          || (draft !== undefined && typeof draft !== 'string') || (messages.length === 0 && !draft)) {
          throw rpcError('INVALID_ARGUMENT', 'Invalid nimi.home-chat.v1 payload')
        }
        const chat: NimiHomeChatPayload = { format, title: suppliedTitle, messages, digest, ...(draft === undefined ? {} : { draft }) }
        const index = await readImportIndex()
        const prior = index[chat.digest]
        if (prior) {
          const sid = SessionId(prior.sessionId)
          const exists = Boolean(ctx.get('sessions')?.get(sid) || await ctx.get('sessionPersistence')?.stat(sid).catch(() => undefined))
          if (exists) {
            return {
              sessionId: prior.sessionId,
              title: prior.title,
              importedMessages: prior.importedCount,
              importedCount: prior.importedCount,
              ...(chat.draft ? { draft: chat.draft } : {}),
              deduplicated: true,
            }
          }
        }

        const workspace = ctx.get('workspaceRegistry')?.list()[0]
        const cwd = workspace?.path ?? homeDir
        const sessionId = SessionId(randomUUID())
        const { createdAt, events } = buildHomeChatSeedEvents(chat)
        const persistence = ctx.get('sessionPersistence') as {
          create(header: SessionHeader, opts: { signal: AbortSignal }): Promise<{
            append(events: readonly SessionEvent[]): Promise<void> | void
            flush(): Promise<void>
            close(): Promise<void>
          }>
        } | undefined

        if (persistence) {
          const header: SessionHeader = {
            version: SESSION_FORMAT_VERSION,
            id: sessionId,
            createdAt,
            cwd,
            isSeeded: false,
          }
          const handle = await persistence.create(header, { signal: effectiveSignal })
          try {
            await handle.append(events)
            await handle.flush()
          } finally {
            await handle.close()
          }
          const projectionCache = ctx.get('sessionProjectionCache' as never) as {
            coldSnapshot?(header: SessionHeader, inheritedEventCount: SessionLogOffset, events: readonly SessionEvent[]): unknown
          } | undefined
          projectionCache?.coldSnapshot?.(header, SessionLogOffset(0), events)
          if (workspace) {
            await workspace.attachSession(sessionId).catch(() => undefined)
          }
        } else {
          // Fallback for minimal test contexts without sessionPersistence.
          ctx.get('sessions')?.create(sessionId, {
            meta: { cwd, createdAt, isSeeded: false },
            seed: events,
            inheritedEventCount: SessionLogOffset(0),
          })
        }

        const title = chat.title.trim() || 'Imported from Nimi Home'
        sessionTitles.set(String(sessionId), title)
        index[chat.digest] = { sessionId: String(sessionId), title, importedCount: chat.messages.length }
        await writeImportIndex(index).catch(() => undefined)
        return {
          sessionId: String(sessionId),
          title,
          importedMessages: chat.messages.length,
          importedCount: chat.messages.length,
          ...(chat.draft ? { draft: chat.draft } : {}),
          deduplicated: false,
        }
      }

      default:
        throw rpcError('UNSUPPORTED_OPERATION', `Unknown worker RPC operation "${operation}"`)
    }
  }

  // 6. Attach Node IPC listener for Host -> Worker RPCs
  if (options.attachProcessRpc !== false) {
    const inFlightRpc = new Map<string, AbortController>()
    const onRpcMessage = (message: unknown): void => {
      if (typeof message !== 'object' || message === null || !('type' in message)) return
      const msg = message as Record<string, unknown>
      if (msg.type === 'nimi-worker-rpc-cancel' && typeof msg.id === 'string') {
        inFlightRpc.get(msg.id)?.abort()
        return
      }
      if (msg.type !== 'nimi-worker-rpc' || typeof msg.id !== 'string' || typeof msg.operation !== 'string') return
      const id = msg.id
      const abort = new AbortController()
      inFlightRpc.set(id, abort)
      void (async () => {
        try {
          const result = await handleWorkerRpc(msg.operation as string, msg.payload, abort.signal)
          const reply: NimiWorkerRpcReply = { type: 'nimi-worker-rpc-reply', id, result }
          if (process.connected) process.send?.(reply)
        } catch (error) {
          const err = error as { message?: unknown; errorCode?: unknown; code?: unknown }
          const reply: NimiWorkerRpcReply = {
            type: 'nimi-worker-rpc-reply',
            id,
            error: typeof err?.message === 'string' ? err.message : String(error),
            ...(typeof err?.errorCode === 'string'
              ? { errorCode: err.errorCode }
              : typeof err?.code === 'string'
                ? { errorCode: err.code }
                : {}),
          }
          if (process.connected) process.send?.(reply)
        } finally {
          inFlightRpc.delete(id)
        }
      })()
    }
    process.on('message', onRpcMessage)
    disposers.push(() => {
      process.off('message', onRpcMessage)
      for (const abort of inFlightRpc.values()) abort.abort()
      inFlightRpc.clear()
    })
  }

  return {
    handleWorkerRpc,
    dispose() {
      for (const dispose of disposers) dispose()
      disposers.length = 0
      for (const pending of pendingDecisions.values()) {
        pending.resolveRemote('rejected')
      }
      pendingDecisions.clear()
    },
  }
}
