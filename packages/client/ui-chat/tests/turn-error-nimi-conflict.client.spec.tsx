// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { TurnErrorNodeView } from '../src/client/chat/MessageItem.tsx'
import { zh, en, type ChatKey } from '../src/client/locale.ts'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'

function makeT(dict: Readonly<Record<ChatKey, string>>): ChatNodeViewProps<'turn-error'>['t'] {
  return ((key: ChatKey) => dict[key]) as ChatNodeViewProps<'turn-error'>['t']
}

function renderTurnError(node: ChatNodeViewProps<'turn-error'>['node'], dict: Readonly<Record<ChatKey, string>>) {
  return render(createElement(TurnErrorNodeView, { node, t: makeT(dict) } as ChatNodeViewProps<'turn-error'>))
}

describe('TurnErrorNodeView AI_CONFIG_REVISION_CONFLICT recovery', () => {
  const originalDesktop = (globalThis as { dshDesktop?: unknown }).dshDesktop

  afterEach(() => {
    cleanup()
    if (originalDesktop === undefined) {
      delete (globalThis as { dshDesktop?: unknown }).dshDesktop
    } else {
      ;(globalThis as { dshDesktop?: unknown }).dshDesktop = originalDesktop
    }
  })

  it('renders an inline Adopt updated configuration action for AI_CONFIG_REVISION_CONFLICT and adopts on click', async () => {
    const adoptLatestRevision = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = {
      protocolVersion: 1,
      nimi: { adoptLatestRevision },
    }

    const view = renderTurnError({
      kind: 'turn-error',
      key: 'turn-error:1',
      id: '1',
      target: 'chat',
      anchorSeq: 1,
      location: { kind: 'session' },
      visibility: 'visible',
      data: {
        kind: 'turn-error',
        seq: 1,
        time: 1000,
        turn: 1,
        step: 1,
        code: 'AI_CONFIG_REVISION_CONFLICT',
        message: 'This Nimi configuration changed (now "gpt-5.4-mini"). Adopt the updated configuration to continue.',
      },
    }, zh)

    const button = view.getByRole('button', { name: zh['message.failure.aiConfigConflict.adopt'] })
    expect(button).toBeTruthy()
    fireEvent.click(button)
    expect(adoptLatestRevision).toHaveBeenCalledOnce()

    await waitFor(() => {
      expect(view.getByText(zh['message.failure.aiConfigConflict.adopted'])).toBeTruthy()
    })
  })

  it('does not render adopt action for unrelated error codes', () => {
    const adoptLatestRevision = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = {
      protocolVersion: 1,
      nimi: { adoptLatestRevision },
    }

    const view = renderTurnError({
      kind: 'turn-error',
      key: 'turn-error:2',
      id: '2',
      target: 'chat',
      anchorSeq: 2,
      location: { kind: 'session' },
      visibility: 'visible',
      data: {
        kind: 'turn-error',
        seq: 2,
        time: 2000,
        turn: 1,
        step: 1,
        code: 'AUTH',
        message: 'Invalid API key',
      },
    }, en)

    expect(view.queryByRole('button')).toBeNull()
  })
})
