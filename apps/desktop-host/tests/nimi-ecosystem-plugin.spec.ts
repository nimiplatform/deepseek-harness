import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  buildDiffPreview,
  buildHomeChatSeedEvents,
  installNimiEcosystemPlugin,
  resolveContainedWorkspacePath,
  type NimiEcosystemClient,
} from '../src/nimi-ecosystem-plugin.ts'

interface TestTool {
  readonly name: string
  execute(input: unknown, context: { signal: AbortSignal; agent?: object }): Promise<unknown>
}

type TestListener = (...args: unknown[]) => Promise<unknown>

function createFakeContext(services: Record<string, unknown>) {
  const listeners = new Map<string, TestListener[]>()
  const registeredTools = new Map<string, TestTool>()
  const toolsService = {
    register: vi.fn((def: TestTool) => {
      registeredTools.set(def.name, def)
      return () => { registeredTools.delete(def.name) }
    }),
  }
  const allServices: Record<string, unknown> = { tools: toolsService, ...services }
  const ctx = {
    get: (key: string) => allServices[key],
    on: (event: string, listener: TestListener, opts?: { prepend?: boolean }) => {
      const list = listeners.get(event) ?? []
      if (opts?.prepend) list.unshift(listener)
      else list.push(listener)
      listeners.set(event, list)
      return () => {
        const idx = list.indexOf(listener)
        if (idx >= 0) list.splice(idx, 1)
      }
    },
  }
  const tool = (name: string): TestTool => {
    const definition = registeredTools.get(name)
    if (definition === undefined) throw new Error(`Missing tool ${name}`)
    return definition
  }
  return { ctx: ctx as never, tool, listeners }
}

describe('Nimi worker ecosystem plugin', () => {
  it('uses the requested session workspace and rejects file access when it is unavailable', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'nimi-remote-workspace-'))
    try {
      await writeFile(join(workspace, 'example.txt'), 'workspace contents')
      const { ctx } = createFakeContext({
        sessions: { get: (id: SessionId) => id === 'open' ? { header: { cwd: workspace } } : undefined },
        sessionPersistence: { stat: async (id: SessionId) => id === 'cold' ? { header: { cwd: workspace } } : undefined },
        workspaceRegistry: { list: () => [{ id: 'default', path: workspace }] },
      })
      const plugin = installNimiEcosystemPlugin(ctx, { attachProcessRpc: false })
      try {
        for (const sessionId of ['open', 'cold']) {
          await expect(plugin.handleWorkerRpc('remote.session.listFiles', { sessionId })).resolves.toMatchObject({
            items: [{ name: 'example.txt', directory: false }],
          })
        }
        await expect(plugin.handleWorkerRpc('remote.session.listFiles', { sessionId: 'missing' }))
          .rejects.toMatchObject({ errorCode: 'SESSION_WORKSPACE_UNAVAILABLE' })
      } finally {
        plugin.dispose()
      }
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('enforces strict workspace realpath containment against traversal and symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nimi-ws-'))
    const outside = await mkdtemp(join(tmpdir(), 'nimi-out-'))
    try {
      await mkdir(join(root, 'sub'), { recursive: true })
      await writeFile(join(root, 'sub', 'ok.txt'), 'safe')
      await writeFile(join(outside, 'secret.txt'), 'secret')
      await symlink(join(outside, 'secret.txt'), join(root, 'escape-link.txt'))

      const ok = await resolveContainedWorkspacePath(root, 'sub/ok.txt')
      expect(ok.relativePosix).toBe('sub/ok.txt')

      await expect(resolveContainedWorkspacePath(root, '../escape')).rejects.toThrow('outside')
      await expect(resolveContainedWorkspacePath(root, '/etc/passwd')).rejects.toThrow('relative')
      await expect(resolveContainedWorkspacePath(root, 'escape-link.txt')).rejects.toThrow('escapes')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('builds structured diff previews for shell, edit, and write tools', () => {
    expect(buildDiffPreview('bash', { command: 'pnpm test' })).toEqual({
      kind: 'command',
      command: 'pnpm test',
    })
    expect(buildDiffPreview('str_replace_editor', { path: 'src/a.ts', old_str: 'foo', new_str: 'bar' })).toEqual({
      kind: 'edit',
      path: 'src/a.ts',
      replacements: [{ oldText: 'foo', newText: 'bar' }],
    })
    expect(buildDiffPreview('write_file', { path: 'notes.md', content: '# Hi' })).toEqual({
      kind: 'write',
      path: 'notes.md',
      content: '# Hi',
    })
  })

  it('builds valid DSH seed logs with surface-node-0 system head for nimi.home-chat.v1', () => {
    const seed = buildHomeChatSeedEvents({
      format: 'nimi.home-chat.v1',
      title: 'Handoff',
      messages: [
        { role: 'user', text: 'First question', timestamp: 1700000001000 },
        { role: 'assistant', text: 'First answer', timestamp: 1700000002000 },
      ],
      digest: 'a'.repeat(64),
    })
    expect(seed.events.map(e => e.type)).toEqual([
      'turn/start',
      'step/start',
      'system/message',
      'user/message',
      'assistant/message',
      'step/end',
      'turn/end',
      'session/title',
    ])
    expect(seed.events[0]?.seq).toBe(0)
    expect(seed.events[7]).toMatchObject({
      seq: 7,
      data: { title: 'Handoff', messageSeqs: [], source: { kind: 'user' } },
    })
  })

  it('registers integration consume & audio tools with approval gating and uncertain-effect honesty', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'nimi-tools-'))
    try {
      await writeFile(join(workspace, 'voice.mp3'), Buffer.from('audio-bytes'))
      const client: NimiEcosystemClient = {
        listIntegrations: vi.fn<NimiEcosystemClient['listIntegrations']>(async () => [
          {
            targetRef: 't-self',
            integrationId: 'ai.nimi.dsh.sessions',
            displayName: 'Self',
            skill: 'self',
            available: true,
            operations: [],
          },
          {
            targetRef: 't-feishu',
            integrationId: 'im.feishu',
            displayName: 'Feishu',
            skill: 'Send and read Feishu messages',
            available: true,
            operations: [
              { name: 'chat.read', displayName: 'Read chat', description: 'Read messages', effect: 'read', retryPolicy: 'safe', supportsCancel: false, inputSchemaJson: '{}', outputSchemaJson: '{}' },
              { name: 'chat.send', displayName: 'Send chat', description: 'Send message', effect: 'write', retryPolicy: 'none', supportsCancel: false, inputSchemaJson: '{}', outputSchemaJson: '{}' },
            ],
          },
        ]),
        invokeIntegration: vi.fn(async () => ({
          callId: 'call-uncertain-9',
          status: 'unconfirmed' as const,
          uncertainEffect: true,
        })),
        getIntegrationCall: vi.fn(async callId => ({
          callId,
          status: 'completed' as const,
          resultJson: '{"ok":true}',
        })),
        cancelIntegrationCall: vi.fn(async () => ({ canceled: true })),
        putActivity: vi.fn(async () => undefined),
        transcribeAudio: vi.fn(async () => ({ text: 'transcribed hello' })),
      }

      const { ctx, tool, listeners } = createFakeContext({
        workspaceRegistry: { list: () => [{ id: 'w1', path: workspace }] },
      })
      const plugin = installNimiEcosystemPlugin(ctx, { client, homeDir: workspace, attachProcessRpc: false })

      const signal = new AbortController().signal
      const found = await tool('find_nimi_integrations').execute({}, { signal })
      expect(found).toMatchObject({ targets: [{ displayName: 'Feishu', operations: [{ effect: 'read' }, { effect: 'write' }] }] })

      // tools/pre-execute MUST return kind:'ask' for invoke_nimi_integration
      const preExec = listeners.get('tools/pre-execute')![0]!
      const decision = await preExec({
        callId: 'call-1',
        name: 'invoke_nimi_integration',
        arguments: { targetRef: 't-feishu', operation: 'chat.send', argumentsJson: '{"text":"hi"}' },
      }, vi.fn(async () => ({ kind: 'allow' })))
      expect(decision).toMatchObject({ kind: 'ask', reason: expect.stringMatching(/(?=.*Feishu)(?=.*write)/u) })

      // Uncertain-effect invocation returns callId honesty without retry
      const invokeRes = await tool('invoke_nimi_integration').execute({
        targetRef: 't-feishu',
        operation: 'chat.send',
        argumentsJson: '{"text":"hi"}',
      }, { signal })
      expect(invokeRes).toMatchObject({
        status: 'unconfirmed',
        callId: 'call-uncertain-9',
        uncertainEffect: true,
      })
      expect(client.invokeIntegration).toHaveBeenCalledTimes(1)
      expect(client.getIntegrationCall).toHaveBeenCalledTimes(0)

      const receipt = await tool('check_nimi_integration_receipt').execute({ callId: 'call-uncertain-9' }, { signal })
      expect(receipt).toMatchObject({ callId: 'call-uncertain-9', status: 'completed', resultJson: '{"ok":true}' })

      const transcribed = await tool('nimi_transcribe_audio').execute({ path: 'voice.mp3', language: 'en' }, { signal })
      expect(transcribed).toMatchObject({ text: 'transcribed hello', path: 'voice.mp3', mimeType: 'audio/mpeg' })

      plugin.dispose()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('bridges remote approval review/resolve with feedback when Desktop UI is unavailable and keeps observeProgress cold-safe', async () => {
    const client: NimiEcosystemClient = {
      listIntegrations: vi.fn(async () => []),
      invokeIntegration: vi.fn(),
      getIntegrationCall: vi.fn(),
      cancelIntegrationCall: vi.fn(),
      putActivity: vi.fn(async () => undefined),
      transcribeAudio: vi.fn(),
    }
    const readSession = vi.fn(async () => ({
      session: { version: 4, id: SessionId('cold-1'), createdAt: 1000, isSeeded: false },
      events: [
        { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
        { type: 'assistant/message', seq: 1, time: 1001, data: { turn: 1, step: 1, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Cold answer' }], source: { kind: 'model', provider: 'nimi', model: 'configured' } }, stream: [] } },
        { type: 'turn/end', seq: 2, time: 1002, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    }))
    const resolveAgent = vi.fn()
    const { ctx, listeners } = createFakeContext({
      sessions: { get: () => undefined, list: () => [] },
      agents: { get: () => undefined },
      sessionQuery: { readSession },
      sessionController: { resolveAgent },
    })

    const plugin = installNimiEcosystemPlugin(ctx, { client, attachProcessRpc: false })

    // Cold observeProgress must NEVER open/resume an agent!
    const progress = await plugin.handleWorkerRpc('remote.session.observeProgress', { sessionId: 'cold-1' })
    expect(progress).toEqual({
      stage: 'done',
      turn: 1,
      text: 'Cold answer',
      truncated: false,
      hasPendingDecision: false,
    })
    expect(resolveAgent).not.toHaveBeenCalled()

    // Dual-channel approval when local UI returns 'unavailable'
    const inject = vi.fn()
    const preExec = listeners.get('tools/pre-execute')![0]!
    await preExec({ callId: 'tc-9', name: 'bash', arguments: { command: 'ls -la' } }, async () => ({ kind: 'allow' }))

    const approvalHandler = listeners.get('approval/request')![0]!
    const approvalPromise = approvalHandler({
      agent: { id: SessionId('live-1'), inject },
      toolName: 'bash',
      callId: 'tc-9',
      reason: 'Run shell command',
    }, async () => 'unavailable')

    // Remote Companion inspects pending decision with structured diffPreview
    const review = await plugin.handleWorkerRpc('remote.session.reviewDecision', { sessionId: 'live-1' }) as { taskId: string; revision: number }
    expect(review).toMatchObject({
      state: 'review',
      taskId: 'tc-9',
      tool: 'bash',
      diffPreview: { kind: 'command', command: 'ls -la' },
    })

    // Remote Companion approves with feedback
    const resolved = await plugin.handleWorkerRpc('remote.session.resolveDecision', {
      sessionId: 'live-1',
      taskId: review.taskId,
      revision: review.revision,
      allow: true,
      feedback: 'Proceed carefully',
    })
    expect(resolved).toEqual({ outcome: 'recorded' })
    await expect(approvalPromise).resolves.toBe('allowed-once')
    expect(inject).toHaveBeenCalledOnce()

    plugin.dispose()
  })

  it('inherits active session configRef in nimi_transcribe_audio and appends events array in nimi.importHomeChat', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-nimi-eco-home-'))
    const homeDir = await mkdtemp(join(tmpdir(), 'dsh-nimi-eco-homedir-'))
    await writeFile(join(workspace, 'clip.wav'), Buffer.from('RIFF0000WAVE'))
    try {
      const appendedBatches: unknown[] = []
      const coldSnapshots: unknown[] = []
      const persistedIds = new Set<string>()
      const transcribeAudio = vi.fn(async () => ({ text: 'hello world' }))
      const client: NimiEcosystemClient = {
        listIntegrations: vi.fn(async () => []),
        invokeIntegration: vi.fn(),
        getIntegrationCall: vi.fn(),
        cancelIntegrationCall: vi.fn(),
        putActivity: vi.fn(async () => undefined),
        transcribeAudio,
      }
      const { ctx, tool } = createFakeContext({
        workspaceRegistry: { list: () => [{ path: workspace, attachSession: vi.fn(async () => undefined) }] },
        sessionPersistence: {
          create: async (header: { id: string }) => {
            persistedIds.add(String(header.id))
            return {
              append: async (events: readonly unknown[]) => {
                expect(Array.isArray(events)).toBe(true)
                appendedBatches.push(events)
              },
              flush: async () => undefined,
              close: async () => undefined,
            }
          },
          stat: async (id: string) => (persistedIds.has(String(id)) ? { id } : undefined),
        },
        sessionProjectionCache: { coldSnapshot: (...args: unknown[]) => { coldSnapshots.push(args) } },
      })

      const plugin = installNimiEcosystemPlugin(ctx, { client, attachProcessRpc: false, homeDir })

      // 1. nimi_transcribe_audio inherits active session configRef (`config.<ref>`) when args.configRef is omitted
      const out = await tool('nimi_transcribe_audio').execute(
        { path: 'clip.wav' },
        { signal: new AbortController().signal, agent: { id: SessionId('s-audio'), model: { current: () => ({ provider: 'nimi', model: 'config.audio-cfg-1' }) } } },
      )
      expect(out).toMatchObject({ text: 'hello world', path: 'clip.wav' })
      expect(transcribeAudio).toHaveBeenCalledWith(expect.objectContaining({ configRef: 'audio-cfg-1' }), expect.any(AbortSignal))

      // 2. nimi.importHomeChat appends events array, refreshes projection cache, and deduplicates cleanly
      const payload = {
        format: 'nimi.home-chat.v1',
        digest: 'a'.repeat(64),
        title: 'Home Chat Sync',
        messages: [
          { role: 'user', text: 'First question' },
          { role: 'assistant', text: 'First answer' },
        ],
        draft: 'Follow up',
      }
      const first = await plugin.handleWorkerRpc('nimi.importHomeChat', payload) as { sessionId: string }
      expect(first).toMatchObject({ title: 'Home Chat Sync', importedMessages: 2, deduplicated: false })
      expect(appendedBatches).toHaveLength(1)
      expect(coldSnapshots).toHaveLength(1)

      const second = await plugin.handleWorkerRpc('nimi.importHomeChat', payload)
      expect(second).toMatchObject({ sessionId: first.sessionId, importedMessages: 2, deduplicated: true })
      expect(appendedBatches).toHaveLength(1)

      plugin.dispose()
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('handles MCP targets with undefined skill in find_nimi_integrations and observes accepted calls to completion without resubmitting', async () => {
    const invokeIntegration = vi.fn(async () => ({
      callId: 'call-mcp-1',
      status: 'accepted' as const,
    }))
    const getIntegrationCall = vi.fn(async () => ({
      callId: 'call-mcp-1',
      status: 'completed' as const,
      resultJson: JSON.stringify({ notes: [{ id: 'note-1', text: 'ok' }] }),
    }))
    const client: NimiEcosystemClient = {
      listIntegrations: vi.fn<NimiEcosystemClient['listIntegrations']>(async () => [
        {
          targetRef: 'icon_mcp_1',
          integrationId: 'mcp',
          displayName: 'Local Acceptance MCP',
          available: true,
          operations: [
            {
              name: 'notes_read',
              displayName: 'Read workspace notes',
              description: 'Read notes',
              effect: 'read' as const,
              retryPolicy: 'none',
              supportsCancel: false,
              inputSchemaJson: '{"type":"object"}',
              outputSchemaJson: '{"type":"object"}',
            },
          ],
        },
      ]),
      invokeIntegration,
      getIntegrationCall,
      cancelIntegrationCall: vi.fn(),
      putActivity: vi.fn(async () => undefined),
      transcribeAudio: vi.fn(),
    }
    const { ctx, tool } = createFakeContext({})

    const plugin = installNimiEcosystemPlugin(ctx, { client, attachProcessRpc: false })
    const found = await tool('find_nimi_integrations').execute(
      { query: 'Local Acceptance', effect: 'all' },
      { signal: new AbortController().signal },
    )
    expect(found).toMatchObject({ targets: [{ displayName: 'Local Acceptance MCP', skill: '' }] })

    const invoked = await tool('invoke_nimi_integration').execute(
      { targetRef: 'icon_mcp_1', operation: 'notes_read', arguments: {} },
      { signal: new AbortController().signal },
    )
    expect(invokeIntegration).toHaveBeenCalledTimes(1)
    expect(getIntegrationCall).toHaveBeenCalledWith('call-mcp-1', expect.any(AbortSignal))
    expect(invoked).toMatchObject({
      status: 'completed',
      callId: 'call-mcp-1',
      resultJson: JSON.stringify({ notes: [{ id: 'note-1', text: 'ok' }] }),
    })
    plugin.dispose()
  })
})
