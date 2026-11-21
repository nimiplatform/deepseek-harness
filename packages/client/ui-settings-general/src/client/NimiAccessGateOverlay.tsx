import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { NimiDesktopHomeSection, NimiDesktopState } from '../types.ts'
import { NimiBrandMark } from './NimiBrand.tsx'
import css from './NimiAccessGateOverlay.module.css'

export interface NimiAccessGateInjected {
  readonly hooks: {
    readonly nimiState: SnapshotStore<NimiDesktopState>
  }
  openHome(section?: NimiDesktopHomeSection): Promise<void>
  recheck(): Promise<NimiDesktopState>
}

export type NimiAccessGateProps =
  & PropsRuntime<'shell.overlay'>
  & PropsLocale<'settings'>
  & InjectFace<NimiAccessGateInjected>

/** In-window Nimi Access Gate shown when signed out or Runtime is unavailable. */
export function NimiAccessGateOverlay({ useNimiState, openHome, recheck, t }: NimiAccessGateProps) {
  const state = useNimiState(s => s)
  const titleId = useId()
  const [busy, setBusy] = useState(false)

  if (state.status !== 'signed-out' && state.status !== 'unavailable') return null

  const title = state.status === 'signed-out'
    ? t('nimi.gate.signedOutTitle')
    : t('nimi.gate.unavailableTitle')
  const description = state.status === 'signed-out'
    ? t('nimi.gate.signedOutDescription')
    : t('nimi.gate.unavailableDescription')

  const handleRecheck = async (): Promise<void> => {
    setBusy(true)
    try {
      await recheck()
    } catch {
      // State store reports the latest posture.
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className={css.overlay} data-nimi-access-gate="true" role="presentation">
      <div className={css.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={css.header}>
          <NimiBrandMark size={28} />
          <h2 id={titleId} className={css.title}>{title}</h2>
        </div>
        <p className={css.body}>{description}</p>
        {state.errorMessage && (
          <div className={css.errorBox} role="alert">{state.errorMessage}</div>
        )}
        <div className={css.actions}>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => { void handleRecheck() }}
          >
            {busy ? t('nimi.status.connecting') : t('nimi.action.recheck')}
          </Button>
          <Button
            variant="primary"
            onClick={() => { void openHome('account').catch(() => undefined) }}
          >
            {t('nimi.action.openHome')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
