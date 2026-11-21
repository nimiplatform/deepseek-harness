import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  NIMI_HARNESS_SESSION_OPERATIONS,
  startNimiSessionProvider,
} from '../src/nimi-session-provider.ts'

describe('Nimi DSH remote session provider (nimi.harness.session.v1)', () => {
  it('declares the exact 13 standardized operations with snapshotRead and assetTransfer flags', () => {
    const names = NIMI_HARNESS_SESSION_OPERATIONS.map(op => op.name)
    expect(names).toEqual([
      'session.list',
      'session.getHistory',
      'session.create',
      'session.submit',
      'session.inputStatus',
      'session.readAnswer',
      'session.stopInput',
      'session.observeProgress',
      'session.reviewDecision',
      'session.resolveDecision',
      'session.listFiles',
      'session.importAttachment',
      'session.downloadResult',
    ])
    const observe = NIMI_HARNESS_SESSION_OPERATIONS.find(o => o.name === 'session.observeProgress')
    expect(observe?.snapshotRead).toBe(true)
    expect(observe?.effect).toBe('read')

    const importOp = NIMI_HARNESS_SESSION_OPERATIONS.find(o => o.name === 'session.importAttachment')
    expect(importOp?.assetTransfer).toBe('to-provider')
    expect(importOp?.effect).toBe('write')

    const downloadOp = NIMI_HARNESS_SESSION_OPERATIONS.find(o => o.name === 'session.downloadResult')
    expect(downloadOp?.assetTransfer).toBe('to-consumer')
    expect(downloadOp?.effect).toBe('write')

    // Nimi Runtime requires retryPolicy === 'none' and supportsCancel === false for all app-provided operations.
    for (const op of NIMI_HARNESS_SESSION_OPERATIONS) {
      expect(op.retryPolicy).toBe('none')
      expect(op.supportsCancel).toBe(false)
    }
  })

  it('dispatches RPC operations, handles asset transfers with SHA-256 verification, and respects invalidation without unregistering', async () => {
    const payloadBytes = Buffer.from('hello remote workspace')
    const payloadSha = `sha256:${createHash('sha256').update(payloadBytes).digest('hex')}`
    const uuid = '11111111-1111-4111-8111-111111111111'

    let pollCount = 0
    const completeProvider = vi.fn(async () => ({ accepted: true }))
    const unregisterProvider = vi.fn(async () => ({ unregistered: true }))
    const registerProvider = vi.fn(async () => ({ targetRef: 'dsh-target-1' }))
    const writeAsset = vi.fn(async () => ({ sha256: payloadSha, sizeBytes: payloadBytes.byteLength, mediaType: 'text/markdown' }))
    const removeAsset = vi.fn(async () => ({ removed: true }))
    const readAsset = vi.fn(async () => ({
      body: (async function* () { yield payloadBytes })(),
    }))

    const scopeAbort = new AbortController()
    const pollProvider = vi.fn(async () => {
      pollCount += 1
      if (pollCount === 1) {
        return {
          canceledCallIds: [],
          calls: [
            {
              callId: 'c-list',
              operation: 'session.list',
              inputJson: '{"offset":0}',
            },
            {
              callId: 'c-observe',
              operation: 'session.observeProgress',
              inputJson: '{"sessionId":"s-1"}',
              afterSnapshot: 'cursor-1',
            },
            {
              callId: 'c-resolve',
              operation: 'session.resolveDecision',
              inputJson: JSON.stringify({ sessionId: 's-1', taskId: 't-1', revision: 2, allow: true, feedback: 'looks good' }),
            },
            {
              callId: 'c-import',
              operation: 'session.importAttachment',
              inputJson: '{"sessionId":"s-1"}',
              offeredAsset: { sha256: payloadSha, mediaType: 'text/plain', sizeBytes: payloadBytes.byteLength },
            },
            {
              callId: 'c-download',
              operation: 'session.downloadResult',
              inputJson: JSON.stringify({ sessionId: 's-1', ref: 'README.md' }),
            },
          ],
        }
      }
      await new Promise<void>((resolve) => {
        if (scopeAbort.signal.aborted) { resolve(); return }
        scopeAbort.signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      return { calls: [], canceledCallIds: [] }
    })

    const rpc = vi.fn(async (operation: string, payload?: unknown) => {
      switch (operation) {
        case 'remote.session.list':
          return { sessions: [{ id: 's-1', title: 'Main' }], nextOffset: null }
        case 'remote.session.observeProgress':
          return { stage: 'idle', turn: 1, text: 'done', truncated: false, hasPendingDecision: false }
        case 'remote.session.resolveDecision':
          return { outcome: 'recorded' }
        case 'remote.session.checkAttachmentWorkspace':
          return undefined
        case 'remote.session.materializeAttachment':
          return { fileId: (payload as { fileId: string }).fileId, ref: '.nimi-attachments/file.txt' }
        case 'remote.session.readFile':
          return {
            fileId: uuid,
            name: 'README.md',
            mediaType: 'text/markdown',
            sizeBytes: payloadBytes.byteLength,
            dataBase64: payloadBytes.toString('base64'),
          }
        default:
          throw new Error(`Unexpected RPC ${operation}`)
      }
    })

    const provider = startNimiSessionProvider({
      integration: {
        registerProvider,
        unregisterProvider,
        pollProvider,
        completeProvider,
      },
      storage: {
        assets: {
          read: readAsset,
          write: writeAsset,
          remove: removeAsset,
        },
      },
    } as never, rpc as never, scopeAbort.signal)

    await expect(provider.targetRef).resolves.toBe('dsh-target-1')
    await vi.waitFor(() => expect(completeProvider).toHaveBeenCalledTimes(5))

    expect(completeProvider).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'c-list',
      errorCode: '',
      resultJson: JSON.stringify({ sessions: [{ id: 's-1', title: 'Main' }], nextOffset: null }),
    }))
    expect(completeProvider).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'c-resolve',
      errorCode: '',
      resultJson: JSON.stringify({ outcome: 'recorded' }),
    }))
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith('remote.session.materializeAttachment', expect.objectContaining({
      sessionId: 's-1',
      dataBase64: payloadBytes.toString('base64'),
    }), expect.any(AbortSignal)))
    expect(completeProvider).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'c-download',
      asset: expect.objectContaining({
        source: { sha256: payloadSha, sizeBytes: payloadBytes.byteLength, mediaType: 'text/markdown' },
      }),
    }))
    expect(writeAsset).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(removeAsset).toHaveBeenCalled())

    // Invalidation stops polling and MUST NOT call unregisterProvider on retired scope!
    scopeAbort.abort()
    await provider.stop(true)
    expect(unregisterProvider).not.toHaveBeenCalled()
  })

  it('unregisters cleanly on normal shutdown when not invalidated', async () => {
    const scopeAbort = new AbortController()
    const unregisterProvider = vi.fn(async () => ({ unregistered: true }))
    let resolvePoll!: () => void
    const provider = startNimiSessionProvider({
      integration: {
        registerProvider: vi.fn(async () => ({ targetRef: 'dsh-target-2' })),
        unregisterProvider,
        pollProvider: vi.fn(() => new Promise((resolve) => {
          resolvePoll = () => resolve({ calls: [], canceledCallIds: [] })
        })),
        completeProvider: vi.fn(),
      },
      storage: { assets: { read: vi.fn(), write: vi.fn(), remove: vi.fn() } },
    } as never, vi.fn() as never, scopeAbort.signal)

    await expect(provider.targetRef).resolves.toBe('dsh-target-2')
    const stopPromise = provider.stop(false)
    resolvePoll()
    await stopPromise
    expect(unregisterProvider).toHaveBeenCalledWith({ targetRef: 'dsh-target-2' })
  })
})
