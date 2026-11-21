/** Pull Nimi text, image, model-catalog, and audio transcription calls on the private parent/child IPC connection. */
import { randomUUID } from 'node:crypto'
import type { NimiLocalAppAIConfigClient, NimiLocalAppArtifactUploadMime, NimiLocalAppTextTurnEvent, NimiLocalAppTextTurnInput } from '@nimiplatform/sdk/app'
import type { NimiErrorFields } from '@nimiplatform/sdk/types'
import { LlmError, type LlmFailure } from '@deepseek-ai/dsh-llm'

export type NimiRouteKind = 'cloud' | 'local' | 'unset'

export type NimiModelInfo = {
  id?: string
  configRef?: string
  revisionIdentity?: string
  name?: string
  routeKind?: NimiRouteKind
  connectorRef?: string
  connectorLabel?: string
  provider?: string
  targetKey?: string
  targetLabel?: string
  ready?: boolean
  configuration?: NimiLocalAppTextTurnInput['configuration']
  imageInput: boolean
  contextWindow?: number
  requestCapacityFloorTokens?: number
  reasoningInput?: Awaited<ReturnType<NimiLocalAppAIConfigClient['get']>>['effectiveSelections'][number]['reasoningInput']
  streamCarriers: readonly { kind: string; version: number }[]
}

export type NimiModelChoice = {
  id: string
  configRef?: string
  name: string
  routeKind?: NimiRouteKind
  connectorRef?: string
  connectorLabel?: string
  provider?: string
  targetKey?: string
  targetLabel?: string
  isDefault?: boolean
  revision?: string
  localLoadoutRevision?: string
}

export type NimiLocalRouteEntry = {
  readonly available: boolean
  readonly state: 'ready' | 'missing' | 'blocked'
  readonly label?: string
  readonly loadoutRef?: string
  readonly reasons: readonly string[]
  readonly configuredFeatures: readonly string[]
  readonly matchedConfigRef?: string
}

export type NimiCloudTargetEntry = {
  readonly targetKey: string
  readonly label: string
  readonly providerModelId?: string
  readonly supportedFeatures: readonly string[]
  readonly matchedConfigRef?: string
  readonly matchedConfigName?: string
}

export type NimiCloudConnectorGroup = {
  readonly connectorRef: string
  readonly label: string
  readonly provider: string
  readonly targets: readonly NimiCloudTargetEntry[]
}

export type NimiRouteCatalog = {
  readonly configs: readonly NimiModelChoice[]
  readonly local: NimiLocalRouteEntry
  readonly cloudConnectors: readonly NimiCloudConnectorGroup[]
}

export type NimiEnsureRouteRequest =
  | { readonly route: 'local' }
  | { readonly route: 'cloud'; readonly connectorRef: string; readonly targetKey: string }

export type NimiEnsureRouteResult = {
  readonly configRef: string
  readonly name: string
  readonly created: boolean
  readonly modelInfo: NimiModelInfo
}

export type NimiAudioTranscriptionResult = {
  readonly jobId: string
  readonly text: string
  readonly language?: string
  readonly segments?: readonly unknown[]
}

type Reply = {
  choices?: readonly NimiModelChoice[]
  routeCatalog?: NimiRouteCatalog
  ensured?: NimiEnsureRouteResult
  modelInfo?: NimiModelInfo
  transcription?: NimiAudioTranscriptionResult
  type: 'nimi-text-reply'
  id: string
  opened?: true
  done?: true
  event?: NimiLocalAppTextTurnEvent
  error?: NimiErrorFields
  artifactId?: string
}

/** Keep the same Runtime failure facts for metadata, attachments and model events. */
export function nimiFailure(error: NimiErrorFields, fallbackCode: string): LlmFailure {
  const code = error.reasonCode || fallbackCode
  let message = error.message || (error.actionHint ? `Nimi: ${code} (${error.actionHint})` : `Nimi: ${code}`)
  if (error.interruption?.resubmitDisposition === 'outcome-uncertain') {
    message += ' The outcome is uncertain. Inspect the last action and its files before deciding whether to continue.'
  } else if (code.toLowerCase().replaceAll('_', '-') === 'ai-provider-unavailable') {
    message += ' Check the model connection in Nimi settings. Review completed file changes before continuing this session.'
  }
  return {
    code,
    message,
    diagnostics: {
      reasonCode: code,
      ...(error.actionHint ? { actionHint: error.actionHint } : {}),
      ...(error.traceId ? { traceId: error.traceId } : {}),
      ...(error.interruption ? {
        interruptionCause: error.interruption.cause,
        resubmitDisposition: error.interruption.resubmitDisposition,
      } : {}),
    },
  }
}

/** Upload one vetted DSH attachment through its protected App Host. */
export async function uploadNimiImage(data: Uint8Array, mimeType: Extract<NimiLocalAppArtifactUploadMime, `image/${string}`>, signal?: AbortSignal): Promise<string> {
  const reply = await callHost({ operation: 'upload-image', mimeType, data: Buffer.from(data).toString('base64') }, signal)
  if (reply.error) {
    throw LlmError.fromFailure(nimiFailure(reply.error, 'NIMI_IMAGE_UPLOAD_FAILED'))
  }
  if (!reply.artifactId) throw new Error('Nimi Desktop Host did not return an image artifact.')
  return reply.artifactId
}

/** Transcribe audio bytes through Nimi Runtime `audio.transcribe` scenario job. */
export async function transcribeNimiAudio(
  input: {
    readonly data: Uint8Array
    readonly mimeType: string
    readonly language?: string
    readonly prompt?: string
    readonly timestamps?: boolean
    readonly configRef?: string
  },
  signal?: AbortSignal,
): Promise<NimiAudioTranscriptionResult> {
  const reply = await callHost({
    operation: 'transcribe-audio',
    mimeType: input.mimeType,
    data: Buffer.from(input.data).toString('base64'),
    ...(input.language ? { language: input.language } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.timestamps === undefined ? {} : { timestamps: input.timestamps }),
    ...(input.configRef ? { configRef: input.configRef } : {}),
  }, signal)
  if (reply.error) {
    throw LlmError.fromFailure(nimiFailure(reply.error, 'NIMI_AUDIO_TRANSCRIBE_FAILED'))
  }
  if (!reply.transcription) throw new Error('Nimi Desktop Host did not return a transcription result.')
  return reply.transcription
}

/** Read the current selection through the parent without transferring connector credentials. */
export async function listNimiModels(): Promise<readonly NimiModelChoice[]> {
  const reply = await callHost({ operation: 'model-list' })
  if (reply.error) throw LlmError.fromFailure(nimiFailure(reply.error, 'NIMI_MODEL_INFO_UNAVAILABLE'))
  if (!reply.choices) throw new Error('The Nimi Host did not return the configuration directory.')
  return reply.choices
}

/** Read full Cloud connectors/targets, Local loadout state, and saved AIConfigs from the Host. */
export async function listNimiRoutes(signal?: AbortSignal): Promise<NimiRouteCatalog> {
  const reply = await callHost({ operation: 'route-catalog' }, signal)
  if (reply.error) throw LlmError.fromFailure(nimiFailure(reply.error, 'NIMI_MODEL_INFO_UNAVAILABLE'))
  if (!reply.routeCatalog) throw new Error('The Nimi Host did not return the model route catalog.')
  return reply.routeCatalog
}

/** Reuse or create a canonical AppAIConfig for a selected Cloud target or Local route. */
export async function ensureNimiRouteConfig(
  request: NimiEnsureRouteRequest,
  signal?: AbortSignal,
): Promise<NimiEnsureRouteResult> {
  const reply = await callHost(
    request.route === 'local'
      ? { operation: 'ensure-route-config', route: 'local' }
      : { operation: 'ensure-route-config', route: 'cloud', connectorRef: request.connectorRef, targetKey: request.targetKey },
    signal,
  )
  if (reply.error) throw LlmError.fromFailure(nimiFailure(reply.error, 'NIMI_ROUTE_CONFIG_FAILED'))
  if (!reply.ensured) throw new Error('The Nimi Host did not return the ensured configuration.')
  return reply.ensured
}

export async function readNimiModelInfo(signal?: AbortSignal, configRef?: string): Promise<NimiModelInfo> {
  const reply = await callHost({ operation: 'model-info', ...(configRef ? { configRef } : {}) }, signal)
  if (reply.error) throw LlmError.fromFailure(nimiFailure(reply.error, 'NIMI_MODEL_INFO_UNAVAILABLE'))
  if (!reply.modelInfo) throw new Error('The Nimi Host did not return model information.')
  return reply.modelInfo
}

type HostRequest =
  | { operation: 'model-info'; configRef?: string }
  | { operation: 'model-list' }
  | { operation: 'route-catalog' }
  | { operation: 'ensure-route-config'; route: 'local' }
  | { operation: 'ensure-route-config'; route: 'cloud'; connectorRef: string; targetKey: string }
  | { operation: 'upload-image'; mimeType: string; data: string }
  | { operation: 'transcribe-audio'; mimeType: string; data: string; language?: string; prompt?: string; timestamps?: boolean; configRef?: string }

async function callHost(request: HostRequest, signal?: AbortSignal): Promise<Reply> {
  signal?.throwIfAborted()
  if (!process.connected || !process.send) throw new Error('The Nimi Desktop Host is unavailable.')
  const id = randomUUID()
  return new Promise<Reply>((resolve, reject) => {
    const cleanup = () => {
      process.off('message', receive)
      process.off('disconnect', disconnected)
      signal?.removeEventListener('abort', abort)
    }
    const fail = (error: unknown) => { cleanup(); reject(error) }
    const abort = () => {
      if (request.operation === 'transcribe-audio' && process.connected) {
        process.send?.({ type: 'nimi-text', id, operation: 'close' }, () => undefined)
      }
      fail(signal?.reason)
    }
    const disconnected = () => fail(new Error('The Nimi Desktop Host disconnected.'))
    const receive = (message: Reply) => {
      if (message?.type !== 'nimi-text-reply' || message.id !== id) return
      cleanup()
      resolve(message)
    }
    process.on('message', receive)
    process.once('disconnect', disconnected)
    signal?.addEventListener('abort', abort, { once: true })
    if (process.send === undefined) { disconnected(); return }
    process.send({ type: 'nimi-text', id, ...request }, (error) => {
      if (error) fail(error)
    })
  })
}

export async function* streamNimiText(input: NimiLocalAppTextTurnInput, signal?: AbortSignal): AsyncGenerator<NimiLocalAppTextTurnEvent> {
  const id = randomUUID()
  let settle: ((reply: Reply) => void) | undefined
  let fail: ((error: unknown) => void) | undefined
  const receive = (message: Reply) => {
    if (message?.type === 'nimi-text-reply' && message.id === id) settle?.(message)
  }
  const disconnected = () => fail?.(new Error('The Nimi Desktop Host disconnected.'))
  const abort = () => fail?.(signal?.reason)
  const send = (operation: 'open' | 'next'): Promise<Reply> => new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    if (!process.connected || !process.send) { reject(new Error('The Nimi Desktop Host is unavailable.')); return }
    settle = resolve
    fail = reject
    process.send({ type: 'nimi-text', id, operation, ...(operation === 'open' ? { input } : {}) }, (error) => {
      if (error) reject(error)
    })
  })
  process.on('message', receive)
  process.once('disconnect', disconnected)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    let reply = await send('open')
    if (!reply.opened && !reply.error) throw new Error('Nimi Desktop Host refused the text turn.')
    for (;;) {
      if (reply.error) {
        yield {
          type: 'failed', sequence: '0', traceId: reply.error.traceId ?? '',
          actionHint: reply.error.actionHint ?? 'check_nimi_home',
          reasonCode: reply.error.reasonCode ?? 'NIMI_TEXT_TURN_FAILED',
          ...(reply.error.interruption === undefined ? {} : { interruption: reply.error.interruption }),
        }
        return
      }
      reply = await send('next')
      if (reply.done) return
      if (reply.event) yield reply.event
      else if (!reply.error) throw new Error('Nimi Desktop Host returned an invalid text event.')
    }
  } finally {
    process.off('message', receive)
    process.off('disconnect', disconnected)
    signal?.removeEventListener('abort', abort)
    if (process.connected) process.send?.({ type: 'nimi-text', id, operation: 'close' }, () => undefined)
  }
}
