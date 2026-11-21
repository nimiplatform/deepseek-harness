import { describe, expect, it, vi } from 'vitest'
import { MessageId, ReasoningEffortId, ToolCallId, type ContentBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { NimiLocalAppTextTurnInput } from '@nimiplatform/sdk/app'
import type { NimiModelInfo } from '../src/nimi-text-client.ts'
import { NimiModelAdapter } from '../src/nimi-model-adapter.ts'

const model = { provider: 'nimi', id: 'configured', name: 'Nimi AIConfig' }
const trace = { traceId: 'test-trace', sequence: '1' }

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('NimiModelAdapter', () => {
  it('distinguishes oversized history from an oversized active tool set before Host inference', async () => {
    let calls = 0
    const adapter = new NimiModelAdapter(model, async function* () { calls++; yield { ...trace, type: 'completed', finishReason: 'stop' } })
    const message = { role: 'user' as const, content: [{ type: 'text' as const, text: 'ok' }] }
    const options = { provider: model.provider, model: model.id, messages: Array.from({ length: 128 }, () => message) }
    await collect(adapter.stream(options))
    await expect(collect(adapter.stream({ ...options, messages: [...options.messages, message] }))).rejects.toThrow('128-message')
    const tools = Array.from({ length: 65 }, (_, i) => ({ name: 't' + i, description: 'test', parameters: { type: 'object' as const } }))
    await expect(collect(adapter.stream({ ...options, tools }))).rejects.toThrow('64 active tools')
    expect(calls).toBe(1)
  })
  it('uses stable configRef model IDs, detects revision conflicts, and adopts latest revision cleanly', async () => {
    const stableId = 'config.main'
    const legacyId = 'config.main.' + 'a'.repeat(64)
    let configuration = { configRef: 'main', expectedRevision: '7' }
    let revisionIdentity = 'a'.repeat(64)
    let targetLabel = 'cloud-work'
    const requests: NimiLocalAppTextTurnInput[] = []
    const adapter = new NimiModelAdapter(model, async function* (input) {
      requests.push(input)
      yield { ...trace, type: 'completed', finishReason: 'stop' }
    }, undefined, async (_signal, ref) => {
      expect(ref).toBe('main')
      return { id: stableId, configRef: 'main', revisionIdentity, name: 'Work', targetLabel, imageInput: false, streamCarriers: [], configuration }
    }, async () => [{ id: stableId, configRef: 'main', name: 'Work', isDefault: true, targetLabel }])
    const directory = await adapter.listModels('nimi')
    expect(directory).toMatchObject([
      { id: model.id, name: model.name, badge: { text: 'cloud-work' } },
      { id: stableId, name: 'Work', badge: { text: 'cloud-work' } },
    ])
    const options: GenerateOptions = { provider: 'nimi', model: stableId, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] }
    await collect(adapter.stream(options))
    expect(requests.map(request => request.configuration)).toEqual([configuration])

    // Revision drift fails closed with AI_CONFIG_REVISION_CONFLICT showing updated target label
    configuration = { configRef: 'main', expectedRevision: '8' }
    revisionIdentity = 'b'.repeat(64)
    targetLabel = 'cloud-work-v2'
    await expect(collect(adapter.stream(options))).rejects.toThrow('cloud-work-v2')
    // Legacy hashed ID also detects drift before adoption
    await expect(collect(adapter.stream({ ...options, model: legacyId }))).rejects.toThrow('configuration changed')
    expect(requests).toHaveLength(1)

    // Explicit adoption resets observed revision so the stable model ID resumes without breaking allowlists
    adapter.adoptLatestRevision('main')
    await collect(adapter.stream(options))
    await collect(adapter.stream({ ...options, model: legacyId }))
    expect(requests).toHaveLength(3)
    expect(requests[1]?.configuration).toEqual(configuration)
  })

  it('refreshes capacity and image support on each exact route lookup', async () => {
    let info: NimiModelInfo = { imageInput: true, contextWindow: 32768, streamCarriers: [] }
    const adapter = new NimiModelAdapter(model, async function* () {}, undefined, async () => info)
    const first = await adapter.resolveModel('nimi', 'configured')
    expect(first.context).toEqual({ contextWindow: 32768 })
    expect(first.inputModalities).toContain('image')
    info = { imageInput: false, streamCarriers: [] }
    const next = await adapter.resolveModel('nimi', 'configured')
    expect(next.context).toBeUndefined()
    expect(next.inputModalities).toEqual(['text'])
  })

  it('offers and sends only admitted reasoning choices, preserving an omitted provider default', async () => {
    const info: NimiModelInfo = { imageInput: false, streamCarriers: [], reasoningInput: {
      followsModelDefault: true, supportsDisabled: true, supportsRequired: true, supportsAdaptive: false,
      supportsBudget: false, efforts: ['low', 'high'], presentations: ['hidden', 'summary'],
    } }
    const sent: NimiLocalAppTextTurnInput[] = []
    const adapter = new NimiModelAdapter(model, async function* (request) {
      sent.push(request)
      yield { ...trace, type: 'completed', finishReason: 'stop' }
    }, undefined, async () => info)
    const options: GenerateOptions = { provider: model.provider, model: model.id, messages: [] }
    expect((await adapter.resolveModel(model.provider, model.id)).reasoning?.efforts.map(choice => choice.id)).toEqual(['off', 'low', 'high'])
    await collect(adapter.stream(options))
    await collect(adapter.stream({ ...options, reasoningEffort: ReasoningEffortId('off') }))
    await collect(adapter.stream({ ...options, reasoningEffort: ReasoningEffortId('low') }))
    expect(sent[0]).not.toHaveProperty('reasoning')
    expect(sent[1]?.reasoning).toEqual({ activation: 'disabled' })
    expect(sent[2]?.reasoning).toEqual({ activation: 'required', effort: 'low', presentation: 'hidden' })
    info.reasoningInput = {
      followsModelDefault: true, supportsDisabled: false, supportsRequired: false, supportsAdaptive: true,
      supportsBudget: true, efforts: ['model-default'], presentations: ['summary'],
    }
    await collect(adapter.stream({ ...options, reasoningEffort: ReasoningEffortId('model-default') }))
    expect(sent[3]?.reasoning).toEqual({ activation: 'adaptive', effort: 'model-default', presentation: 'summary' })
    delete info.reasoningInput
    await expect(collect(adapter.stream({ ...options, reasoningEffort: ReasoningEffortId('low') }))).rejects.toThrow('unavailable')
    expect(sent).toHaveLength(4)
  })

  it('continues from another source with its public answer and matched tool result', async () => {
    const requests: NimiLocalAppTextTurnInput[] = []
    const adapter = new NimiModelAdapter(model, async function* (input) {
      requests.push(input)
      yield { ...trace, type: 'completed', finishReason: 'stop' }
    })
    const id = ToolCallId('archived-read')
    const source = { kind: 'model' as const, provider: 'chat-export', model: 'archived' }
    await collect(adapter.stream({ provider: model.provider, model: model.id, messages: [
      { id: MessageId('archived-step'), role: 'assistant', source, content: [
        { type: 'reasoning', text: 'Historical reasoning' }, { type: 'text', text: 'Checking the handoff.' },
        { type: 'tool-call', id, name: 'read', arguments: '{"path":"handoff.md"}' },
      ] },
      { role: 'tool', id: MessageId('archived-result'), source: { kind: 'tool', callId: id }, toolCallId: id, content: [{ type: 'text', text: 'Ready Friday.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
    ] }))
    expect(requests[0]?.messages[0]?.turnItems?.map(item => item.type === 'output' ? item.output.type : item.type)).toEqual(['text', 'tool-call'])
    expect(requests[0]?.messages[1]?.turnItems?.[0]).toMatchObject({ type: 'tool-result', toolResult: { toolCallId: id, toolName: 'read', result: 'Ready Friday.' } })
  })

  it('replays only stream-compatible reasoning bytes in their original positions on each selected route', async () => {
    const carrier = { kind: 'test-model.continuity', version: 2, payload: [255, 0, 3] }
    const source = { kind: 'model' as const, provider: model.provider, model: model.id,
      replayState: { response: { continuity: [{ itemIndex: 0, carrier }] }, blocks: [1] } }
    let input: NimiLocalAppTextTurnInput | undefined
    let info: NimiModelInfo = { imageInput: false, streamCarriers: [carrier] }
    const adapter = new NimiModelAdapter(model, async function* (received) {
      input = received
      yield { ...trace, type: 'completed', finishReason: 'stop' }
    }, undefined, async () => info)
    const options: GenerateOptions = { provider: model.provider, model: model.id, messages: [
      { id: MessageId('answer'), role: 'assistant', source, content: [{ type: 'text', text: 'Prior answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
    ] }
    const text = { type: 'output', output: { type: 'text', text: 'Prior answer' } }
    await collect(adapter.stream(options))
    expect(input?.messages[0]?.turnItems).toEqual([{ type: 'output', output: { type: 'reasoning-continuity', carrier } }, text])
    info = { imageInput: false, streamCarriers: [{ kind: carrier.kind, version: 1 }] }
    await collect(adapter.stream(options))
    expect(input?.messages[0]?.turnItems).toEqual([text])
  })

  it('publishes reported aggregate usage including zero without a cache estimate', async () => {
    for (const usage of [
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
    ]) {
      const adapter = new NimiModelAdapter(model, async function* () {
        yield { ...trace, type: 'delta', itemIndex: 0, text: 'Answer.' }
        yield { ...trace, sequence: '2', type: 'completed', finishReason: 'stop', usage }
      })
      const chunks = await collect(adapter.stream({ provider: 'nimi', model: 'configured', messages: [{ role: 'user', content: [{ type: 'text', text: 'Answer.' }] }] }))
      expect(chunks.find(chunk => chunk.type === 'usage')).toEqual({ type: 'usage', usage: {
        inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, totalTokens: usage.totalTokens,
      } })
    }
  })
  it('preserves a rejected tool proposal and subsequent model output without inventing usage', async () => {
    let received: NimiLocalAppTextTurnInput | undefined
    const adapter = new NimiModelAdapter(model, async function* (input) {
      received = input
      yield { ...trace, type: 'delta', itemIndex: 0, text: 'Corrected.' }
      yield { ...trace, sequence: '2', type: 'completed', finishReason: 'stop' }
    })
    const callId = ToolCallId('call-1')
    const options: GenerateOptions = {
      provider: model.provider,
      model: model.id,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Write a file.' }] },
        { id: MessageId('assistant-1'), source: { kind: 'model', provider: model.provider, model: model.id },
          role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'write', arguments: '{}' }] },
        { id: MessageId('tool-1'), source: { kind: 'tool', callId }, role: 'tool', toolCallId: callId,
          isError: true, content: [{ type: 'text', text: 'Missing required content.' }] },
      ],
    }
    const chunks = await collect(adapter.stream(options))
    expect(received?.messages[2]?.turnItems).toEqual([{ type: 'tool-result', toolResult: {
      toolCallId: 'call-1', toolName: 'write', result: 'Missing required content.', isError: true,
    } }])
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'finish'])
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('preserves Nimi interruption facts in the terminal error', async () => {
    const interruption = { cause: 'runtime-restart' as const, resubmitDisposition: 'outcome-uncertain' as const }
    const adapter = new NimiModelAdapter(model, async function* () {
      yield { ...trace, type: 'failed', reasonCode: 'AI_EXECUTION_INTERRUPTED', actionHint: 'review_result', interruption }
    })
    const chunks = await collect(adapter.stream({
      provider: model.provider, model: model.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'Continue.' }] }],
    }))
    expect(chunks).toEqual([{
      type: 'finish', reason: { kind: 'error', failure: {
        code: 'AI_EXECUTION_INTERRUPTED', message: expect.stringContaining('Inspect the last action and its files'),
        diagnostics: { reasonCode: 'AI_EXECUTION_INTERRUPTED', actionHint: 'review_result', traceId: 'test-trace',
          interruptionCause: 'runtime-restart', resubmitDisposition: 'outcome-uncertain' },
      } },
    }])
  })

  it('offers image input and sends a tool image after its correlated result', async () => {
    let received: NimiLocalAppTextTurnInput | undefined
    const attachment: Extract<ContentBlock, { type: 'image' }>['attachment'] = {
      attachmentId: 'vision-test' as Extract<ContentBlock, { type: 'image' }>['attachment']['attachmentId'],
      mediaType: 'image/png', bytes: 16, width: 2, height: 2,
    }
    const visualModel = { ...model, inputModalities: ['text', 'image'] as const }
    const adapter = new NimiModelAdapter(visualModel, async function* (input) {
      received = input
      yield { ...trace, type: 'delta', itemIndex: 0, text: 'Image seen.' }
      yield { ...trace, sequence: '2', type: 'completed', finishReason: 'stop' }
    }, async (ref) => {
      expect(ref).toEqual(attachment)
      return 'owned-image'
    })
    expect(await adapter.resolveModel(model.provider, model.id)).toEqual(visualModel)
    const callId = ToolCallId('read-image-1')
    await collect(adapter.stream({
      provider: model.provider, model: model.id, messages: [
        { role: 'user', content: [{ type: 'text', text: 'Read the image.' }] },
        { id: MessageId('assistant-1'), source: { kind: 'model', provider: model.provider, model: model.id },
          role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'read_image', arguments: '{}' }] },
        { id: MessageId('tool-1'), source: { kind: 'tool', callId }, role: 'tool', toolCallId: callId,
          content: [{ type: 'image', attachment }] },
      ],
    }))
    expect(received?.messages[2]?.turnItems?.[0]).toMatchObject({ type: 'tool-result', toolResult: { toolCallId: callId, toolName: 'read_image' } })
    expect(received?.messages[3]?.parts).toEqual([
      { type: 'text', text: 'Image returned by tool read_image (call read-image-1).' },
      { type: 'artifact-ref', artifactId: 'owned-image', mediaType: 'image/png' },
    ])
  })

  it('exposes deduplicated Saved, Local, and Cloud Connector provider groups and materializes selections to canonical configRef', async () => {
    const ensureRouteConfig = vi.fn(async (req: { route: string; connectorRef?: string; targetKey?: string }) => ({
      configRef: req.route === 'local' ? '1'.repeat(32) : '2'.repeat(32),
      name: req.route === 'local' ? 'Local · Qwen3-8B' : 'dashscope / qwen3.7-max',
      created: true,
      modelInfo: { id: 'config.' + '2'.repeat(32), configRef: '2'.repeat(32), name: 'dashscope / qwen3.7-max', imageInput: false, streamCarriers: [] },
    }))
    const onCatalogChanged = vi.fn()
    const adapter = new NimiModelAdapter(
      model,
      async function* () { yield { ...trace, type: 'completed', finishReason: 'stop' } },
      undefined,
      async () => ({ id: 'config.main', configRef: 'main', name: 'Default', targetLabel: 'gpt-6-luna', imageInput: false, streamCarriers: [] }),
      undefined,
      {
        listRoutes: async () => ({
          configs: [
            { id: 'config.main', configRef: 'main', name: 'Default', isDefault: true, revision: '7', routeKind: 'cloud', connectorRef: 'c-openai', connectorLabel: 'openai', provider: 'openai', targetLabel: 'gpt-6-luna' },
          ],
          local: { available: true, state: 'ready', label: 'Qwen3-8B', loadoutRef: 'l-1', reasons: [], configuredFeatures: [] },
          cloudConnectors: [{
            connectorRef: 'c-dash',
            label: 'dashscope',
            provider: 'dashscope',
            targets: [{ targetKey: '{"provider":"dashscope","providerModelId":"qwen3.7-max"}', label: 'qwen3.7-max', providerModelId: 'qwen3.7-max', supportedFeatures: ['input.image'] }],
          }],
        }),
        ensureRouteConfig,
        onCatalogChanged,
      },
    )

    await adapter.refreshRoutes()
    expect(adapter.providerIds()).toEqual(['nimi', 'nimi-local', 'nimi-cloud.c-dash'])

    // Saved group has NO duplicate `configured` entry
    const saved = await adapter.listModels('nimi')
    expect(saved.map(m => m.id)).toEqual(['config.main'])
    expect(saved[0]?.badge?.text).toBe('gpt-6-luna · openai')

    // Local group exposes ready machine model
    const localModels = await adapter.listModels('nimi-local')
    expect(localModels).toMatchObject([{ id: 'local', name: 'Qwen3-8B' }])

    // Cloud connector group exposes its models and resolves image capability without extra RPCs
    const cloudModels = await adapter.listModels('nimi-cloud.c-dash')
    expect(cloudModels).toMatchObject([{ name: 'qwen3.7-max' }])
    const resolvedCloud = await adapter.resolveModel('nimi-cloud.c-dash', cloudModels[0]!.id)
    expect(resolvedCloud.inputModalities).toEqual(['text', 'image'])

    // Committing a Cloud selection materializes canonical `provider: 'nimi', model: 'config.<ref>'`
    const committedCloud = await adapter.commitModelSelection('nimi-cloud.c-dash', cloudModels[0]!.id)
    expect(committedCloud).toEqual({ provider: 'nimi', model: 'config.' + '2'.repeat(32) })
    expect(ensureRouteConfig).toHaveBeenCalledWith({
      route: 'cloud',
      connectorRef: 'c-dash',
      targetKey: cloudModels[0]!.id,
    }, undefined)
    expect(onCatalogChanged).toHaveBeenCalledOnce()

    // Committing Local materializes canonical `provider: 'nimi', model: 'config.<ref>'`
    const committedLocal = await adapter.commitModelSelection('nimi-local', 'local')
    expect(committedLocal).toEqual({ provider: 'nimi', model: 'config.' + '1'.repeat(32) })

    // Streaming directly against an uncommitted virtual route fails closed with a clear message
    await expect(collect(adapter.stream({
      provider: 'nimi-cloud.c-dash',
      model: cloudModels[0]!.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi.' }] }],
    }))).rejects.toThrow('named configuration')
  })
})
