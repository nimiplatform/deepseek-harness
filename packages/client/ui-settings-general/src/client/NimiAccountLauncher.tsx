import { useRef, useState } from 'react'
import {
  IconDataOutlineMedium,
  IconPersonalizationOutlineMedium,
  IconSettingsOutlineMedium,
  IconUserOutlineMedium,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { NimiDesktopHomeSection, NimiDesktopState } from '../types.ts'
import css from './NimiAccountLauncher.module.css'

export interface NimiAccountLauncherInjected {
  readonly hooks: {
    readonly nimiState: SnapshotStore<NimiDesktopState>
  }
  openHome(section?: NimiDesktopHomeSection): Promise<void>
  recheck(): Promise<NimiDesktopState>
}

export type NimiAccountLauncherProps =
  & PropsRuntime<'settings.launcher'>
  & PropsLocale<'settings'>
  & InjectFace<NimiAccountLauncherInjected>

function initialsOf(state: NimiDesktopState): string {
  const source = state.account?.displayName || state.account?.handle || 'N'
  const clean = source.replace(/^@/u, '').trim()
  return (clean.slice(0, 1) || 'N').toUpperCase()
}

/** Persistent workspace sidebar footer Nimi account status + quick navigation menu. */
export function NimiAccountLauncher({
  wide,
  settingsShortcut,
  openSettings,
  useNimiState,
  openHome,
  recheck,
  t,
}: NimiAccountLauncherProps) {
  const state = useNimiState(s => s)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const displayName = state.account?.displayName
    ?? (state.account?.handle ? `@${state.account.handle.replace(/^@/u, '')}` : t('nimi.account.defaultName'))

  const statusLabel = state.status === 'ready'
    ? t('nimi.status.ready')
    : state.status === 'connecting'
      ? t('nimi.status.connecting')
      : state.status === 'signed-out'
        ? t('nimi.status.signedOut')
        : t('nimi.status.unavailable')

  return (
    <div className={css.root}>
      <Menu
        open={open}
        side="top"
        portal
        autoFocus
        className={css.anchor}
        anchor={
          <button
            ref={triggerRef}
            type="button"
            className={css.trigger}
            data-collapsed={!wide}
            data-nimi-status={state.status}
            aria-label={`${displayName} — ${statusLabel}`}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(prev => !prev) }}
          >
            <span className={css.badge} aria-hidden="true">
              {initialsOf(state)}
              <span className={css.dot} data-status={state.status} />
            </span>
            {wide && (
              <span className={css.meta}>
                <span className={css.name}>{displayName}</span>
                <span className={css.status}>{statusLabel}</span>
              </span>
            )}
          </button>
        }
        items={[
          { id: 'account', label: t('nimi.nav.account'), icon: <IconUserOutlineMedium size={16} /> },
          { id: 'models', label: t('nimi.nav.models'), icon: <IconDataOutlineMedium size={16} /> },
          { id: 'integrations', label: t('nimi.nav.integrations'), icon: <IconPersonalizationOutlineMedium size={16} /> },
          {
            id: 'general',
            label: t('trigger'),
            icon: <IconSettingsOutlineMedium size={16} />,
            ...(settingsShortcut === undefined ? {} : { shortcut: settingsShortcut }),
          },
          { id: 'home', label: t('nimi.action.openHome'), icon: <IconUserOutlineMedium size={16} /> },
          { id: 'recheck', label: t('nimi.action.recheck'), icon: <IconSettingsOutlineMedium size={16} /> },
        ]}
        onClose={() => { setOpen(false) }}
        onSelect={(id) => {
          setOpen(false)
          if (id === 'account' || id === 'models' || id === 'integrations' || id === 'general') {
            triggerRef.current?.focus()
            openSettings(id)
          } else if (id === 'home') {
            void openHome('account').catch(() => undefined)
          } else if (id === 'recheck') {
            void recheck().catch(() => undefined)
          }
        }}
      />
    </div>
  )
}
