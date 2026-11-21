import { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { NimiLocalAppAIConsumptionClient } from '@nimiplatform/sdk/app'
import { createNimiError } from '@nimiplatform/sdk/types'
import { createNimiModelCatalog, serveNimiText } from '../src/nimi-text.ts'

const request = { messages: [{ role: 'user' as const, text: 'Hello.' }] }
const id = '00000000-0000-4000-8000-000000000001'

function setup(streamTurn: NimiLocalAppAIConsumptionClient['text']['streamTurn']) {
  const child = Object.assign(new ChildProcess(), {
    connected: true,
    send: vi.fn((_message: object, callback: (error: Error | null) => void) => { callback(null); return true }),
  })
  const upload = vi.fn(async () => ({ artifactId: 'owned-image', sizeBytes: 3, mimeType: 'image/png' as const }))
  const bridge = serveNimiText(child, { text: { streamTurn }, artifacts: { upload, read: vi.fn() } })
  return { child, bridge, upload }
}

describe('Nimi text IPC server', () => {
  it('forwards the selected reasoning input to the protected text client', async () => {
    const reasoning = { activation: 'required', effort: 'low', presentation: 'hidden' } as const
    const received = vi.fn()
    const { bridge } = setup(async (input) => {
      received(input.reasoning)
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'completed', sequence: '1', traceId: 'test', finishReason: 'stop' } },
        async cancel() {},
      }
    })
    bridge.receive({ type: 'nimi-text', operation: 'open', id, input: { ...request, reasoning } })
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(reasoning))
    bridge.dispose()
  })

  it('pulls one event at a time and releases the stream on EOF', async () => {
    const next = vi.fn()
    const cancel = vi.fn()
    const { bridge, child } = setup(async () => ({
      async *[Symbol.asyncIterator]() {
        next()
        yield { type: 'completed', sequence: '1', traceId: 'test', finishReason: 'stop' as const }
      },
      cancel,
    }))
    expect(bridge.receive({ type: 'other' })).toBe(false)
    bridge.receive({ type: 'nimi-text', operation: 'open', id, input: request })
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledWith({ type: 'nimi-text-reply', id, opened: true }, expect.any(Function)))
    expect(next).not.toHaveBeenCalled()
    bridge.receive({ type: 'nimi-text', operation: 'next', id })
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledWith({
      type: 'nimi-text-reply', id, event: { type: 'completed', sequence: '1', traceId: 'test', finishReason: 'stop' },
    }, expect.any(Function)))
    bridge.receive({ type: 'nimi-text', operation: 'next', id })
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledWith({ type: 'nimi-text-reply', id, done: true }, expect.any(Function)))
    bridge.receive({ type: 'nimi-text', operation: 'next', id })
    expect(child.send).toHaveBeenLastCalledWith({
      type: 'nimi-text-reply', id, error: { reasonCode: 'NIMI_TEXT_STREAM_INVALID', actionHint: 'restart_the_app_request' },
    }, expect.any(Function))
    child.emit('disconnect')
    expect(cancel).not.toHaveBeenCalled()
  })

  it('cancels a pending open after close or disconnect, with no late reply', async () => {
    for (const method of ['close', 'disconnect']) {
      let resolve!: (stream: Awaited<ReturnType<NimiLocalAppAIConsumptionClient['text']['streamTurn']>>) => void
      const cancel = vi.fn()
      const { bridge, child } = setup(() => new Promise((accept) => { resolve = accept }))
      bridge.receive({ type: 'nimi-text', operation: 'open', id, input: request })
      await Promise.resolve()
      if (method === 'close') bridge.receive({ type: 'nimi-text', operation: 'close', id })
      else { child.connected = false; child.emit('disconnect') }
      resolve({ async *[Symbol.asyncIterator]() {}, cancel })
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
      expect(child.send).not.toHaveBeenCalled()
    }
  })

  it('preserves structured error and uncertain-outcome facts across an open failure', async () => {
    const interruption = { cause: 'runtime-restart' as const, resubmitDisposition: 'outcome-uncertain' as const }
    const error = createNimiError({
      reasonCode: 'AI_EXECUTION_INTERRUPTED', actionHint: 'review_outcome', traceId: 'native-trace',
      interruption, message: 'Interrupted.', retryable: false,
    })
    const { bridge, child } = setup(async () => { throw error })
    bridge.receive({ type: 'nimi-text', operation: 'open', id, input: request })
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'nimi-text-reply', id,
      error: expect.objectContaining({
        reasonCode: 'AI_EXECUTION_INTERRUPTED', actionHint: 'review_outcome', traceId: 'native-trace', interruption,
      }),
    }), expect.any(Function)))
  })

  it('rejects excessive opens before creating another protected request', async () => {
    const open = vi.fn(async () => ({ async *[Symbol.asyncIterator]() {}, cancel: vi.fn() }))
    const { bridge, child } = setup(open)
    for (let index = 0; index < 9; index++) {
      bridge.receive({ type: 'nimi-text', operation: 'open', id: id.slice(0, -1) + index, input: request })
    }
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(8))
    expect(child.send).toHaveBeenCalledWith({
      type: 'nimi-text-reply', id: id.slice(0, -1) + '8',
      error: { reasonCode: 'NIMI_TEXT_CAPACITY_EXCEEDED', actionHint: 'restart_the_app_request' },
    }, expect.any(Function))
    bridge.dispose()
  })

  it('publishes stable config.<configRef> model IDs without embedded sha256 hashes', async () => {
    const catalog = createNimiModelCatalog({
      get: vi.fn(async (query?: { configRef?: string; includeRecords?: boolean }) => ({
        record: { configRef: query?.configRef ?? 'work', name: 'Work', revision: 'rev-1', isDefault: true },
        records: [{ configRef: 'work', name: 'Work', revision: 'rev-1', isDefault: true }],
        revision: 'rev-1',
        config: { capabilities: [] },
        effectiveSelections: [{
          capabilityContract: 'text.generate',
          state: 'ready',
          resource: { oneofKind: 'cloud', cloud: { connector: { connectorRef: 'c1', label: 'Cloud' }, target: { label: 'Model-A', providerModelTarget: {} } } },
          reasons: [],
        }],
      })),
    } as never)
    const models = await catalog.list()
    expect(models).toHaveLength(1)
    expect(models[0]?.id).toBe('config.work')
    expect(models[0]?.configRef).toBe('work')
    expect(models[0]?.revision).toBe('rev-1')
    const info = await catalog.get('work')
    expect(info.id).toBe('config.work')
    expect(info.revisionIdentity).toMatch(/^[0-9a-f]{64}$/u)
    expect(info.configuration).toEqual({ configRef: 'work', expectedRevision: 'rev-1' })
  })

  it('transcribes audio over Host<->Worker IPC via scenarioJobs', async () => {
    const child = Object.assign(new ChildProcess(), {
      connected: true,
      send: vi.fn((_message: object, callback: (error: Error | null) => void) => { callback(null); return true }),
    })
    const submit = vi.fn(async () => ({
      job: {
        jobId: 'job-1',
        status: 'completed' as const,
        transcriptionText: 'hello from nimi audio',
        transcription: { status: 'transcribed' as const, text: 'hello from nimi audio', language: 'en', words: [] },
      },
    }))
    const bridge = serveNimiText(child, {
      text: { streamTurn: vi.fn() },
      artifacts: { upload: vi.fn() },
      scenarioJobs: { submit, get: vi.fn(), subscribe: vi.fn(), cancel: vi.fn() },
    } as never)

    bridge.receive({
      type: 'nimi-text',
      operation: 'transcribe-audio',
      id,
      data: Buffer.from('fake-audio').toString('base64'),
      mimeType: 'audio/mpeg',
      language: 'en',
      configRef: 'a'.repeat(32),
    })
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'nimi-text-reply',
      id,
      transcription: expect.objectContaining({ text: 'hello from nimi audio', language: 'en' }),
    }), expect.any(Function)))
    expect(submit).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'speech-transcribe',
      responseFormat: '',
    }), { configRef: 'a'.repeat(32) })
    bridge.dispose()
  })

  it('lists Cloud connectors/targets alongside Local loadout status and reuses or creates canonical AppAIConfig on demand', async () => {
    const cloudTargetA = { provider: 'openai', providerModelId: 'gpt-6-luna', remoteModelCatalogId: 'cat-luna' }
    const cloudTargetB = { provider: 'dashscope', providerModelId: 'qwen3.7-max', remoteModelCatalogId: 'cat-qwen' }
    const implOpenai = { driverId: 'nimillm', implementationId: 'openai', driverDialect: 'openai' }
    const implDashscope = { driverId: 'nimillm', implementationId: 'dashscope', driverDialect: 'openai-compatible' }
    const audioIntent = {
      capabilityContract: 'audio.transcribe',
      requiredFeatures: [],
      route: { oneofKind: 'cloud' as const, cloud: { connectorRef: 'conn-openai', providerModelTarget: {} } },
    }
    const store = new Map<string, {
      record: { configRef: string; name: string; revision: string; isDefault: boolean }
      capabilities: unknown[]
      effective: unknown[]
    }>([
      ['main', {
        record: { configRef: 'main', name: 'Default', revision: '7', isDefault: true },
        capabilities: [
          audioIntent,
          {
            capabilityContract: 'text.generate',
            requiredFeatures: [],
            route: { oneofKind: 'cloud', cloud: { connectorRef: 'conn-openai', implementation: implOpenai, providerModelTarget: cloudTargetA } },
          },
        ],
        effective: [{
          capabilityContract: 'text.generate',
          state: 'ready',
          resource: {
            oneofKind: 'cloud',
            cloud: {
              connector: { connectorRef: 'conn-openai', label: 'openai', provider: 'openai' },
              target: { label: 'gpt-6-luna', providerModelTarget: cloudTargetA, supportedFeatures: ['input.image'] },
            },
          },
          reasons: [],
        }],
      }],
    ])

    let localReady = false
    const overwrite = vi.fn(async (input: {
      record?: { action: string; name?: string }
      capabilities: { capabilityContract: string; route?: { oneofKind: string } }[]
    }) => {
      const ref = 'a'.repeat(32)
      const name = input.record?.name ?? 'Created'
      const record = { configRef: ref, name, revision: '1', isDefault: false }
      const textCap = input.capabilities.find(capability => capability.capabilityContract === 'text.generate')
      const isLocal = textCap?.route?.oneofKind === 'local'
      store.set(ref, {
        record,
        capabilities: input.capabilities,
        effective: [{
          capabilityContract: 'text.generate',
          state: 'ready',
          resource: isLocal
            ? { oneofKind: 'local', local: { loadoutRef: 'loc-1', label: 'Qwen3-8B', implementation: { implementationId: 'llama' }, configuredFeatures: [] } }
            : { oneofKind: 'cloud', cloud: { connector: { connectorRef: 'conn-dash', label: 'dashscope', provider: 'dashscope' }, target: { label: 'qwen3.7-max', providerModelTarget: cloudTargetB, supportedFeatures: [] } } },
          reasons: [],
        }],
      })
      return { outcome: 'committed' as const, record, revision: '1', config: { capabilities: input.capabilities } }
    })

    const catalog = createNimiModelCatalog({
      get: vi.fn(async (query?: { configRef?: string; includeRecords?: boolean }) => {
        const entry = store.get(query?.configRef ?? 'main')!
        return {
          record: entry.record,
          records: query?.includeRecords ? [...store.values()].map(v => v.record) : undefined,
          revision: entry.record.revision,
          config: { capabilities: entry.capabilities },
          effectiveSelections: entry.effective,
        }
      }),
      listOptions: vi.fn(async (query: { kind: string; connectorRef?: string }) => {
        if (query.kind === 'local-loadouts') {
          return {
            kind: 'local-loadouts' as const,
            options: localReady ? [{ loadoutRef: 'loc-1', label: 'Qwen3-8B', capabilityContract: 'text.generate', state: 'ready' as const, reasons: [], configuredFeatures: [] }] : [],
            truncated: false,
          }
        }
        if (query.kind === 'cloud-connectors') {
          return {
            kind: 'cloud-connectors' as const,
            options: [
              { connectorRef: 'conn-openai', label: 'openai', provider: 'openai', state: 'ready' as const, reasons: [] },
              { connectorRef: 'conn-dash', label: 'dashscope', provider: 'dashscope', state: 'ready' as const, reasons: [] },
            ],
            truncated: false,
          }
        }
        if (query.connectorRef === 'conn-openai') {
          return {
            kind: 'cloud-targets' as const,
            options: [
              {
                connectorRef: 'conn-openai',
                label: 'gpt-6-luna',
                capabilityContract: 'text.generate',
                implementation: implOpenai,
                providerModelTarget: cloudTargetA,
                supportedFeatures: ['input.image'],
                textBehaviors: [{ kind: 'tool-use', implementationSupported: true, configurationState: 'configured', reasons: [], configuredToolUse: { supportsStream: true } }],
                state: 'ready' as const,
                reasons: [],
              },
              {
                connectorRef: 'conn-openai',
                label: 'gpt-5.4-nano',
                capabilityContract: 'text.generate',
                implementation: implOpenai,
                providerModelTarget: { provider: 'openai', providerModelId: 'gpt-5.4-nano', remoteModelCatalogId: 'cat-nano' },
                supportedFeatures: [],
                textBehaviors: [{ kind: 'tool-use', implementationSupported: false, configurationState: 'unavailable', reasons: ['TEXT_BEHAVIOR_UNAVAILABLE'] }],
                state: 'ready' as const,
                reasons: [],
              },
            ],
            truncated: false,
          }
        }
        return {
          kind: 'cloud-targets' as const,
          options: [
            { connectorRef: 'conn-dash', label: 'qwen3.7-max', capabilityContract: 'text.generate', implementation: implDashscope, providerModelTarget: cloudTargetB, supportedFeatures: [], state: 'ready' as const, reasons: [] },
            {
              connectorRef: 'conn-dash',
              label: 'qwen3.8-flash',
              capabilityContract: 'text.generate',
              implementation: implDashscope,
              providerModelTarget: { provider: 'dashscope', providerModelId: 'qwen3.8-flash', remoteModelCatalogId: 'cat-q38' },
              supportedFeatures: [],
              textBehaviors: [{ kind: 'tool-use', implementationSupported: true, configurationState: 'configured', reasons: [], configuredToolUse: { supportsStream: false } }],
              state: 'ready' as const,
              reasons: [],
            },
          ],
          truncated: false,
        }
      }),
      overwrite,
    } as never)

    const routes = await catalog.listRoutes()
    expect(routes.local.available).toBe(false)
    expect(routes.cloudConnectors.map(c => c.label)).toEqual(['openai', 'dashscope'])
    expect(routes.cloudConnectors[0]?.targets.map(t => t.label)).toEqual(['gpt-6-luna'])
    expect(routes.cloudConnectors[1]?.targets.map(t => t.label)).toEqual(['qwen3.7-max'])
    expect(routes.cloudConnectors[0]?.targets[0]?.matchedConfigRef).toBe('main')

    // Reuses existing config when Cloud target already matches `main`
    const reused = await catalog.ensureRouteConfig({
      route: 'cloud',
      connectorRef: 'conn-openai',
      targetKey: routes.cloudConnectors[0]!.targets[0]!.targetKey,
    })
    expect(reused.created).toBe(false)
    expect(reused.configRef).toBe('main')
    expect(overwrite).not.toHaveBeenCalled()

    // Rejects Local when no local model is configured in Nimi Home
    await expect(catalog.ensureRouteConfig({ route: 'local' })).rejects.toThrow('No ready on-device text model')

    // Creates ONE canonical named AppAIConfig when choosing a brand new Cloud target, preserving audio.transcribe
    const created = await catalog.ensureRouteConfig({
      route: 'cloud',
      connectorRef: 'conn-dash',
      targetKey: routes.cloudConnectors[1]!.targets[0]!.targetKey,
    })
    expect(created.created).toBe(true)
    expect(created.name).toBe('dashscope / qwen3.7-max')
    expect(overwrite).toHaveBeenCalledOnce()
    const createdCaps = overwrite.mock.calls[0]![0].capabilities as { capabilityContract: string }[]
    expect(createdCaps.map(c => c.capabilityContract).sort()).toEqual(['audio.transcribe', 'text.generate'])

    // Once Local becomes ready, ensureRouteConfig({ route: 'local' }) creates a Local AppAIConfig
    localReady = true
    const localRoutes = await catalog.listRoutes()
    expect(localRoutes.local.available).toBe(true)
    expect(localRoutes.local.label).toBe('Qwen3-8B')
  })
})
