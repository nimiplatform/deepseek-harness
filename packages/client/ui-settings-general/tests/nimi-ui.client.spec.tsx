// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { allowAllAccess, bindSnapshotSelector, contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { en } from '../src/client/locales.ts'
import { NimiAccountLauncher } from '../src/client/NimiAccountLauncher.tsx'
import { NimiAccountSection } from '../src/client/NimiAccountSection.tsx'
import { NimiModelsSection } from '../src/client/NimiModelsSection.tsx'
import { NimiIntegrationsSection } from '../src/client/NimiIntegrationsSection.tsx'
import { NimiAccessGateOverlay } from '../src/client/NimiAccessGateOverlay.tsx'
import { NimiBrandMark, NimiBrandName } from '../src/client/NimiBrand.tsx'
import type { NimiDesktopAiConfigOverwriteInput, NimiDesktopAiConfigSnapshot, NimiDesktopState } from '../src/types.ts'

afterEach(() => { cleanup() })

const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
const unusedHook = (() => { throw new Error('unused') }) as never
const useSessionStatus: GlobalStandardProps['useSessionStatus'] = selector => selector(new Map())

const kit = {
  useSessions: unusedHook,
  useSessionStatus,
  usePanelInfo,
  useSessionRetainInfo: () => undefined,
  useResource,
  useWorkspaces: unusedHook,
  ...allowAllAccess,
  useContextMenu: contextMenuHook(),
}

const t = ((key: string, params?: Record<string, string>) => {
  let copy = (en as Record<string, string>)[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) copy = copy.replace(`{${k}}`, v)
  }
  return copy
}) as never

describe('Option A Native Nimi Cordis UI', () => {
  it('renders NimiBrandMark and NimiBrandName cleanly', () => {
    render(<div><NimiBrandMark size={20} /><NimiBrandName /></div>)
    expect(screen.getByText('Nimi DSH')).toBeTruthy()
  })

  it('renders NimiAccountLauncher with account status and opens Settings/Home actions', () => {
    const store = createSnapshotStore<NimiDesktopState>({
      status: 'ready',
      appId: 'ai.nimi.dsh',
      account: { displayName: 'Ada Lovelace', handle: 'ada' },
    })
    const openSettings = vi.fn()
    const openHome = vi.fn(async () => {})
    const recheck = vi.fn(async () => store.getSnapshot())

    render(
      <NimiAccountLauncher
        {...kit}
        t={t}
        wide={true}
        settingsOpen={false}
        openSettings={openSettings}
        openOnboarding={() => {}}
        useNimiState={bindSnapshotSelector(store)}
        openHome={openHome}
        recheck={recheck}
      />,
    )

    const trigger = screen.getByRole('button', { name: /Ada Lovelace/ })
    expect(trigger.getAttribute('data-nimi-status')).toBe('ready')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText(en['nimi.nav.models']))
    expect(openSettings).toHaveBeenCalledWith('models')
  })

  it('shows NimiAccessGateOverlay only when signed-out or unavailable and triggers Recheck / Open Home', async () => {
    const store = createSnapshotStore<NimiDesktopState>({
      status: 'signed-out',
      appId: 'ai.nimi.dsh',
      errorMessage: 'Session expired',
    })
    const openHome = vi.fn(async () => {})
    const recheck = vi.fn(async (): Promise<NimiDesktopState> => ({ status: 'ready', appId: 'ai.nimi.dsh' }))

    render(
      <NimiAccessGateOverlay
        {...kit}
        t={t}
        useNimiState={bindSnapshotSelector(store)}
        openHome={openHome}
        recheck={recheck}
      />,
    )

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Session expired')).toBeTruthy()
    fireEvent.click(screen.getByText(en['nimi.action.openHome']))
    expect(openHome).toHaveBeenCalledWith('account')
    fireEvent.click(screen.getByText(en['nimi.action.recheck']))
    await waitFor(() => expect(recheck).toHaveBeenCalledOnce())
  })

  it('renders NimiAccountSection and imports nimi.home-chat.v1 JSON into a session', async () => {
    const store = createSnapshotStore<NimiDesktopState>({
      status: 'ready',
      appId: 'ai.nimi.dsh',
      account: { displayName: 'Grace', handle: 'grace', userId: 'u-1' },
    })
    const importHomeChat = vi.fn(async () => ({
      sessionId: 'sess-9',
      title: 'Imported Chat',
      importedMessages: 3,
      draft: 'Continue here',
      deduplicated: false,
    }))
    const openSession = vi.fn()
    const close = vi.fn()

    render(
      <NimiAccountSection
        {...kit}
        t={t}
        close={close}
        useNimiState={bindSnapshotSelector(store)}
        openHome={vi.fn(async () => {})}
        recheck={vi.fn(async () => store.getSnapshot())}
        importHomeChat={importHomeChat}
        openSession={openSession}
      />,
    )

    expect(screen.getByText(/Grace/)).toBeTruthy()
    const textarea = screen.getByLabelText(en['nimi.import.jsonLabel'])
    fireEvent.change(textarea, { target: { value: '{"format":"nimi.home-chat.v1","messages":[]}' } })
    fireEvent.click(screen.getByText(en['nimi.import.submit']))

    await waitFor(() => expect(screen.getByText(/Imported "Imported Chat"/)).toBeTruthy())
    fireEvent.click(screen.getByText(en['nimi.import.openSession']))
    expect(openSession).toHaveBeenCalledWith('sess-9')
    expect(close).toHaveBeenCalledOnce()
  })

  it('renders NimiModelsSection with native Headless AIConfig save and conflict recovery', async () => {
    const snapshot: NimiDesktopAiConfigSnapshot = {
      record: { configRef: 'work', name: 'Work', revision: 'rev-1', isDefault: true },
      records: [{ configRef: 'work', name: 'Work', revision: 'rev-1', isDefault: true }],
      revision: 'rev-1',
      config: {
        capabilities: [{
          capabilityContract: 'text.generate',
          requiredFeatures: [],
          route: { oneofKind: 'local', local: { loadoutRef: 'local-1' } },
        }],
      },
      effectiveSelections: [{
        capabilityContract: 'text.generate',
        state: 'ready',
        resource: { oneofKind: 'local', local: { loadoutRef: 'local-1', label: 'Qwen Local' } },
        reasons: [],
      }],
    }

    const aiConfig = {
      get: vi.fn(async () => snapshot),
      listOptions: vi.fn(async (q: { kind: string; capabilityContract?: string }) => {
        if (q.kind === 'local-loadouts') {
          return {
            kind: 'local-loadouts' as const,
            options: [{ loadoutRef: 'local-1', label: 'Qwen Local', capabilityContract: q.capabilityContract ?? 'text.generate', state: 'ready' as const, reasons: [] }],
            truncated: false,
          }
        }
        return { kind: 'cloud-connectors' as const, options: [], truncated: false }
      }),
      overwrite: vi.fn(async () => ({
        outcome: 'committed' as const,
        record: snapshot.record!,
        config: snapshot.config!,
        revision: 'rev-2',
      })),
    }
    const adoptLatestRevision = vi.fn(async () => {})

    render(
      <NimiModelsSection
        {...kit}
        t={t}
        close={() => {}}
        openNimiSettings={vi.fn(async () => {})}
        openHome={vi.fn(async () => {})}
        adoptLatestRevision={adoptLatestRevision}
        aiConfig={aiConfig}
      />,
    )

    await waitFor(() => expect(screen.getByDisplayValue('Work')).toBeTruthy())
    fireEvent.click(screen.getByText(en['nimi.models.saveAction']))
    await waitFor(() => expect(aiConfig.overwrite).toHaveBeenCalledOnce())
    expect(adoptLatestRevision).toHaveBeenCalledWith('work')
  })

  it('pre-selects cloud target model even when providerModelTarget arrives in Protobuf Struct or unsorted key order', async () => {
    const cloudTarget = {
      provider: 'openai',
      providerModelId: 'gpt-6-luna',
      remoteModelCatalogId: 'cat-luna',
    }
    const implementation = { driverId: 'nimillm', implementationId: 'openai', driverDialect: 'openai' }
    const snapshot: NimiDesktopAiConfigSnapshot = {
      record: { configRef: 'main', name: 'Default', revision: '7', isDefault: true },
      records: [{ configRef: 'main', name: 'Default', revision: '7', isDefault: true }],
      revision: '7',
      config: {
        capabilities: [{
          capabilityContract: 'text.generate',
          requiredFeatures: [],
          route: {
            oneofKind: 'cloud',
            cloud: {
              connectorRef: 'conn-openai',
              implementation,
              providerModelTarget: {
                remoteModelCatalogId: 'cat-luna',
                providerModelId: 'gpt-6-luna',
                provider: 'openai',
              },
            },
          },
        }],
      },
      effectiveSelections: [{
        capabilityContract: 'text.generate',
        state: 'ready',
        resource: {
          oneofKind: 'cloud',
          cloud: {
            connector: { connectorRef: 'conn-openai', label: 'openai' },
            target: { label: 'gpt-6-luna', providerModelTarget: cloudTarget },
          },
        },
        reasons: [],
      }],
    }

    const aiConfig = {
      get: vi.fn(async () => snapshot),
      listOptions: vi.fn(async (q: { kind: string }) => {
        if (q.kind === 'cloud-connectors') {
          return {
            kind: 'cloud-connectors' as const,
            options: [{ connectorRef: 'conn-openai', label: 'openai', provider: 'openai', state: 'ready' as const, reasons: [] }],
            truncated: false,
          }
        }
        if (q.kind === 'cloud-targets') {
          return {
            kind: 'cloud-targets' as const,
            options: [{
              connectorRef: 'conn-openai',
              label: 'gpt-6-luna',
              capabilityContract: 'text.generate',
              implementation,
              providerModelTarget: cloudTarget,
              state: 'ready' as const,
              reasons: [],
            }],
            truncated: false,
          }
        }
        return { kind: 'local-loadouts' as const, options: [], truncated: false }
      }),
      overwrite: vi.fn(async (_input: NimiDesktopAiConfigOverwriteInput) => ({
        outcome: 'committed' as const,
        record: snapshot.record!,
        config: snapshot.config!,
        revision: '8',
      })),
    }

    render(
      <NimiModelsSection
        {...kit}
        t={t}
        close={() => {}}
        openNimiSettings={vi.fn(async () => {})}
        openHome={vi.fn(async () => {})}
        aiConfig={aiConfig}
      />,
    )

    await waitFor(() => {
      const targetSelect = screen.getByLabelText(en['nimi.models.targetLabel']) as HTMLSelectElement
      expect(targetSelect.selectedOptions[0]?.textContent).toBe('gpt-6-luna')
    })
    fireEvent.click(screen.getByText(en['nimi.models.saveAction']))
    await waitFor(() => expect(aiConfig.overwrite).toHaveBeenCalledOnce())
    const route = aiConfig.overwrite.mock.calls[0]?.[0].capabilities[0]?.route
    expect(route).toMatchObject({ cloud: { implementation } })
  })

  it('renders NimiIntegrationsSection listing read and write operations', async () => {
    const listCatalog = vi.fn(async () => [{
      targetRef: 't-1',
      integrationId: 'im.telegram',
      displayName: 'Telegram Bot',
      accountLabel: '@nimi',
      kind: 'connection',
      available: true,
      permittedOperations: ['messages.list', 'messages.send'],
      operations: [
        { name: 'messages.list', displayName: 'List messages', description: 'Read inbox', effect: 'read' },
        { name: 'messages.send', displayName: 'Send message', description: 'Post reply', effect: 'write' },
      ],
    }])
    const openHome = vi.fn(async () => {})

    render(
      <NimiIntegrationsSection
        {...kit}
        t={t}
        close={() => {}}
        listCatalog={listCatalog}
        openHome={openHome}
      />,
    )

    await waitFor(() => expect(screen.getByText('Telegram Bot')).toBeTruthy())
    expect(screen.getByText('List messages')).toBeTruthy()
    expect(screen.getByText('Send message')).toBeTruthy()
    expect(screen.getByText(en['nimi.integrations.effectRead'])).toBeTruthy()
    expect(screen.getByText(en['nimi.integrations.effectWrite'])).toBeTruthy()

    fireEvent.click(screen.getByText(en['nimi.integrations.manageInHome']))
    expect(openHome).toHaveBeenCalledWith('integrations')
  })
})
