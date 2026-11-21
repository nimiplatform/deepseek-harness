import { useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  NimiDesktopHomeChatImportResult,
  NimiDesktopHomeSection,
  NimiDesktopState,
} from '../types.ts'
import css from './NimiSection.module.css'

export interface NimiAccountSectionInjected {
  readonly hooks: {
    readonly nimiState: SnapshotStore<NimiDesktopState>
  }
  openHome(section?: NimiDesktopHomeSection): Promise<void>
  recheck(): Promise<NimiDesktopState>
  importHomeChat?(sourceJson: string): Promise<NimiDesktopHomeChatImportResult>
  openSession?(sessionId: string): void
}

export type NimiAccountSectionProps =
  & PropsRuntime<'settings.section'>
  & PropsLocale<'settings'>
  & InjectFace<NimiAccountSectionInjected>

/** Native Nimi Account, Runtime posture, and Home Chat (`nimi.home-chat.v1`) handoff section. */
export function NimiAccountSection({
  useNimiState,
  openHome,
  recheck,
  importHomeChat,
  openSession,
  close,
  t,
}: NimiAccountSectionProps) {
  const state = useNimiState(s => s)
  const [rechecking, setRechecking] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [importJson, setImportJson] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<NimiDesktopHomeChatImportResult | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const tone = state.status === 'ready'
    ? 'ready'
    : state.status === 'connecting'
      ? 'warning'
      : 'error'

  const statusText = state.status === 'ready'
    ? t('nimi.status.ready')
    : state.status === 'connecting'
      ? t('nimi.status.connecting')
      : state.status === 'signed-out'
        ? t('nimi.status.signedOut')
        : t('nimi.status.unavailable')

  const handleRecheck = async (): Promise<void> => {
    setRechecking(true)
    setActionError(null)
    try {
      await recheck()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('nimi.settingsError'))
    } finally {
      setRechecking(false)
    }
  }

  const handleOpenHome = async (section: NimiDesktopHomeSection): Promise<void> => {
    setActionError(null)
    try {
      await openHome(section)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('nimi.settingsError'))
    }
  }

  const handleImport = async (raw: string): Promise<void> => {
    if (!importHomeChat) return
    const trimmed = raw.trim()
    if (!trimmed) return
    setImporting(true)
    setImportError(null)
    setImportResult(null)
    try {
      const result = await importHomeChat(trimmed)
      setImportResult(result)
      setImportJson('')
    } catch (error) {
      setImportError(error instanceof Error ? error.message : t('nimi.import.error'))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className={css.stack}>
      <section className={css.card}>
        <div className={css.headerRow}>
          <div className={css.headerCopy}>
            <h3 className={css.title}>{t('nimi.account.title')}</h3>
            <p className={css.description}>{t('nimi.account.description')}</p>
          </div>
          <span className={css.pill} data-tone={tone}>{statusText}</span>
        </div>

        <dl className={css.metaList}>
          <dt className={css.metaKey}>{t('nimi.account.identityLabel')}</dt>
          <dd className={css.metaValue}>
            {state.account?.displayName ?? t('nimi.account.defaultName')}
            {state.account?.handle ? ` (@${state.account.handle.replace(/^@/u, '')})` : ''}
          </dd>
          {state.account?.userId && (
            <>
              <dt className={css.metaKey}>{t('nimi.account.userIdLabel')}</dt>
              <dd className={css.metaValue}>{state.account.userId}</dd>
            </>
          )}
          <dt className={css.metaKey}>{t('nimi.account.appIdLabel')}</dt>
          <dd className={css.metaValue}>{state.appId}</dd>
        </dl>

        {state.errorMessage && (
          <div className={css.notice} data-tone="error" role="alert">{state.errorMessage}</div>
        )}
        {actionError && (
          <div className={css.notice} data-tone="error" role="alert">{actionError}</div>
        )}

        <div className={css.actions}>
          <Button variant="primary" size="sm" onClick={() => { void handleOpenHome('account') }}>
            {t('nimi.action.openHomeAccount')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => { void handleOpenHome('apps') }}>
            {t('nimi.action.openHomePermissions')}
          </Button>
          <Button variant="outline" size="sm" disabled={rechecking} onClick={() => { void handleRecheck() }}>
            {rechecking ? t('nimi.status.connecting') : t('nimi.action.recheck')}
          </Button>
        </div>
      </section>

      {importHomeChat && (
        <section className={css.card}>
          <div className={css.headerRow}>
            <div className={css.headerCopy}>
              <h3 className={css.title}>{t('nimi.import.title')}</h3>
              <p className={css.description}>{t('nimi.import.description')}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={importing}
              onClick={() => { fileInputRef.current?.click() }}
            >
              {t('nimi.import.chooseFile')}
            </Button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              void file.text().then((text) => {
                setImportJson(text)
                return handleImport(text)
              })
            }}
          />

          <details className={css.details}>
            <summary className={css.detailsSummary}>{t('nimi.import.pasteToggle')}</summary>
            <div className={css.detailsBody}>
              <div className={css.field}>
                <label className={css.label} htmlFor="nimi-home-chat-json">{t('nimi.import.jsonLabel')}</label>
                <textarea
                  id="nimi-home-chat-json"
                  className={css.textarea}
                  value={importJson}
                  placeholder={t('nimi.import.placeholder')}
                  onChange={(event) => { setImportJson(event.target.value) }}
                />
              </div>
              <div className={css.actions}>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={importing || !importJson.trim()}
                  onClick={() => { void handleImport(importJson) }}
                >
                  {importing ? t('nimi.status.connecting') : t('nimi.import.submit')}
                </Button>
              </div>
            </div>
          </details>

          {importError && <div className={css.notice} data-tone="error" role="alert">{importError}</div>}
          {importResult && (
            <div className={css.notice} data-tone="success" role="status">
              <div>
                {importResult.deduplicated
                  ? t('nimi.import.deduplicated', { title: importResult.title, count: String(importResult.importedMessages) })
                  : t('nimi.import.success', { title: importResult.title, count: String(importResult.importedMessages) })}
              </div>
              {importResult.draft && (
                <div style={{ marginTop: 4 }}>{t('nimi.import.draftPreserved', { draft: importResult.draft })}</div>
              )}
              {openSession && (
                <div style={{ marginTop: 8 }}>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      openSession(importResult.sessionId)
                      close()
                    }}
                  >
                    {t('nimi.import.openSession')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
