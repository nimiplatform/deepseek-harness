import { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  compileAiConfigOverwriteInput,
  installNimiActivityOpenHandler,
  NIMI_DSH_SESSION_PROVIDER_ID,
  parseNimiHomeChatExport,
  projectAiConfigSnapshotForUi,
  projectIntegrationCatalogForUi,
  projectIntegrationCatalogForWorker,
  serveNimiEcosystem,
} from '../src/nimi-ecosystem.ts'

function createMockChild() {
  return Object.assign(new ChildProcess(), {
    connected: true,
    send: vi.fn((_message: object, callback?: (error: Error | null) => void) => {
      callback?.(null)
      return true
    }),
  })
}

const sampleCatalog = [
  {
    targetRef: 'target-self',
    integrationId: NIMI_DSH_SESSION_PROVIDER_ID,
    displayName: 'Nimi DSH',
    accountLabel: 'local',
    kind: 'app-provider',
    available: true,
    skill: 'self',
    permittedOperations: ['session.list'],
    operations: [{
      name: 'session.list',
      displayName: 'List sessions',
      description: 'List sessions',
      effect: 'read',
      retryPolicy: 'safe',
      supportsCancel: false,
      inputSchemaJson: '{}',
      outputSchemaJson: '{}',
    }],
  },
  {
    targetRef: 'target-telegram',
    integrationId: 'im.telegram',
    displayName: 'Telegram',
    accountLabel: '@bot',
    kind: 'connection',
    available: true,
    skill: 'Messaging over Telegram',
    permittedOperations: ['messages.list', 'messages.send'],
    operations: [
      {
        name: 'messages.list',
        displayName: 'Read messages',
        description: 'Read recent messages',
        effect: 'read',
        retryPolicy: 'safe',
        supportsCancel: false,
        inputSchemaJson: '{"type":"object"}',
        outputSchemaJson: '{"type":"object"}',
      },
      {
        name: 'messages.send',
        displayName: 'Send message',
        description: 'Send a Telegram message',
        effect: 'write',
        retryPolicy: 'none',
        supportsCancel: false,
        inputSchemaJson: '{"type":"object","required":["text"]}',
        outputSchemaJson: '{"type":"object"}',
      },
      {
        name: 'admin.deleteAll',
        displayName: 'Delete all',
        description: 'Unpermitted op',
        effect: 'write',
        retryPolicy: 'none',
        supportsCancel: false,
        inputSchemaJson: '{}',
        outputSchemaJson: '{}',
      },
    ],
  },
] as const

describe('Nimi ecosystem host bridge', () => {
  it('excludes own ai.nimi.dsh.sessions target and preserves both read and write permitted operations', () => {
    const uiTargets = projectIntegrationCatalogForUi(sampleCatalog as never)
    expect(uiTargets).toHaveLength(1)
    expect(uiTargets[0]?.integrationId).toBe('im.telegram')
    expect(uiTargets[0]?.operations.map(o => [o.name, o.effect])).toEqual([
      ['messages.list', 'read'],
      ['messages.send', 'write'],
    ])

    const workerTargets = projectIntegrationCatalogForWorker(sampleCatalog as never)
    expect(workerTargets).toHaveLength(1)
    expect(workerTargets[0]?.operations.map(o => o.name)).toEqual(['messages.list', 'messages.send'])
  })

  it('honors uncertain-effect receipt honesty without blind retry on accepted/unconfirmed writes', async () => {
    const child = createMockChild()
    const invoke = vi.fn(async () => ({
      callId: 'call-write-1',
      targetRef: 'target-telegram',
      operation: 'messages.send',
      status: 'unconfirmed' as const,
      resultJson: '',
      errorCode: 'DELIVERY_UNCONFIRMED',
      targetDisplayName: 'Telegram',
      accountLabel: '@bot',
      createdAt: null,
      updatedAt: null,
    }))
    const getCall = vi.fn(async () => ({
      callId: 'call-write-1',
      targetRef: 'target-telegram',
      operation: 'messages.send',
      status: 'completed' as const,
      resultJson: '{"sent":true}',
      errorCode: '',
      targetDisplayName: 'Telegram',
      accountLabel: '@bot',
      createdAt: null,
      updatedAt: null,
    }))
    const put = vi.fn(async () => ({ record: { activityId: 'act-1' }, changed: true }))
    const bridge = serveNimiEcosystem(child, {
      integration: {
        listCatalog: vi.fn(async () => sampleCatalog),
        invoke,
        getCall,
        cancelCall: vi.fn(),
      },
      activity: { put },
    } as never)

    const id1 = '00000000-0000-4000-8000-000000000001'
    const id2 = '00000000-0000-4000-8000-000000000002'
    const id3 = '00000000-0000-4000-8000-000000000003'

    bridge.receive({
      type: 'nimi-ecosystem',
      id: id1,
      operation: 'integration-invoke',
      targetRef: 'target-telegram',
      operationName: 'messages.send',
      inputJson: '{"text":"hello"}',
    })
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'nimi-ecosystem-reply',
      id: id1,
      call: expect.objectContaining({
        callId: 'call-write-1',
        status: 'unconfirmed',
        uncertainEffect: true,
      }),
    }), expect.any(Function)))
    // Must NEVER blindly retry an uncertain write!
    expect(invoke).toHaveBeenCalledTimes(1)

    // Subsequent receipt check queries getCall without re-invoking
    bridge.receive({
      type: 'nimi-ecosystem',
      id: id2,
      operation: 'integration-get-call',
      callId: 'call-write-1',
    })
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'nimi-ecosystem-reply',
      id: id2,
      call: expect.objectContaining({
        callId: 'call-write-1',
        status: 'completed',
        resultJson: '{"sent":true}',
      }),
    }), expect.any(Function)))
    expect(getCall).toHaveBeenCalledWith({ callId: 'call-write-1' })

    // Activity publishing forwards attention & objectRef
    bridge.receive({
      type: 'nimi-ecosystem',
      id: id3,
      operation: 'activity-put',
      input: {
        key: 'session:s1',
        revision: 1,
        kind: 'todo',
        attention: true,
        title: 'Approval needed',
        type: 'dsh.approval.pending',
        occurredAt: new Date().toISOString(),
        summary: 'bash',
        objectRef: 'session:s1',
        todoState: 'open',
      },
    })
    await vi.waitFor(() => expect(put).toHaveBeenCalledWith(expect.objectContaining({
      objectRef: 'session:s1',
      attention: true,
      revision: 1,
    })))
    bridge.dispose()
  })

  it('handles Host -> Worker RPC roundtrips cleanly', async () => {
    const child = createMockChild()
    const bridge = serveNimiEcosystem(child, {
      integration: { listCatalog: vi.fn(), invoke: vi.fn(), getCall: vi.fn(), cancelCall: vi.fn() },
      activity: { put: vi.fn() },
    } as never)

    const promise = bridge.callWorker<{ ok: boolean }>('remote.session.list', { offset: 0 })
    const sent = child.send.mock.calls[0]?.[0] as { type: string; id: string; operation: string }
    expect(sent).toMatchObject({ type: 'nimi-worker-rpc', operation: 'remote.session.list' })
    bridge.receive({ type: 'nimi-worker-rpc-reply', id: sent.id, result: { ok: true } })
    await expect(promise).resolves.toEqual({ ok: true })
    bridge.dispose()
  })

  it('routes activity.onOpenRequest for session:<id> to focus and open session', async () => {
    let openCb: ((request: { requestId: string; objectRef: string }) => Promise<string> | string) | undefined
    const stop = vi.fn(async () => undefined)
    const sessionExists = vi.fn(async () => true)
    const focusAndOpenSession = vi.fn()
    const off = installNimiActivityOpenHandler({
      onOpenRequest: vi.fn((cb) => {
        openCb = cb
        return { stop }
      }),
    } as never, { sessionExists, focusAndOpenSession })

    const outcome = await openCb?.({ requestId: 'req-1', objectRef: 'session:abc-123' })
    expect(sessionExists).toHaveBeenCalledWith('abc-123')
    expect(focusAndOpenSession).toHaveBeenCalledWith('abc-123')
    expect(outcome).toBe('opened')
    await off()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('validates nimi.home-chat.v1 handoff JSON with deterministic digest and rejects invalid payloads', () => {
    const json = JSON.stringify({
      format: 'nimi.home-chat.v1',
      title: 'Architecture Discussion',
      messages: [
        { role: 'user', text: 'Explain Nimi Runtime', timestamp: 1700000000000 },
        { role: 'assistant', text: 'Nimi Runtime owns AI and storage.' },
      ],
      draft: 'Follow up on WebRTC',
    })
    const first = parseNimiHomeChatExport(json)
    const second = parseNimiHomeChatExport(json)
    expect(first.format).toBe('nimi.home-chat.v1')
    expect(first.title).toBe('Architecture Discussion')
    expect(first.messages).toHaveLength(2)
    expect(first.draft).toBe('Follow up on WebRTC')
    expect(first.digest).toBe(second.digest)
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/u)

    expect(() => parseNimiHomeChatExport('{"format":"other","messages":[]}')).toThrow('nimi.home-chat.v1')
    expect(() => parseNimiHomeChatExport('{"format":"nimi.home-chat.v1","messages":[]}')).toThrow('neither messages nor a draft')
  })

  it('unwraps Protobuf Struct fields on aiConfig read and compiles canonical SDK intents on overwrite', () => {
    const rawSnapshot = {
      revision: '7',
      config: {
        capabilities: [{
          capabilityContract: 'text.generate',
          requiredFeatures: [],
          route: {
            oneofKind: 'cloud' as const,
            cloud: {
              connectorRef: 'conn-1',
              implementation: { driverId: 'nimillm', implementationId: 'openai', driverDialect: 'openai' },
              providerModelTarget: {
                fields: {
                  provider: { kind: { oneofKind: 'stringValue', stringValue: 'openai' } },
                  providerModelId: { kind: { oneofKind: 'stringValue', stringValue: 'gpt-6-luna' } },
                  remoteModelCatalogId: { kind: { oneofKind: 'stringValue', stringValue: 'cat-1' } },
                },
              },
            },
          },
        }],
      },
    }
    const projected = projectAiConfigSnapshotForUi(rawSnapshot)
    expect(projected.config?.capabilities?.[0]).toEqual({
      capabilityContract: 'text.generate',
      requiredFeatures: [],
      route: {
        oneofKind: 'cloud',
        cloud: {
          connectorRef: 'conn-1',
          implementation: { driverId: 'nimillm', implementationId: 'openai', driverDialect: 'openai' },
          providerModelTarget: {
            provider: 'openai',
            providerModelId: 'gpt-6-luna',
            remoteModelCatalogId: 'cat-1',
          },
        },
      },
    })

    const compiled = compileAiConfigOverwriteInput({
      expectedRevision: '7',
      capabilities: [
        projected.config!.capabilities![0]!,
        {
          capabilityContract: 'audio.transcribe',
          requiredFeatures: [],
          route: { oneofKind: 'local', local: {} },
        },
      ],
    })
    expect(compiled.capabilities).toHaveLength(2)
    expect(compiled.capabilities[0]?.route.oneofKind).toBe('cloud')
    expect(compiled.capabilities[1]?.route).toEqual({ oneofKind: 'local', local: {} })
  })
})
