import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NimiDesktopHomeSection, NimiDesktopIntegrationTargetView } from '../types.ts'
import css from './NimiSection.module.css'

export interface NimiIntegrationsSectionInjected {
  listCatalog(): Promise<readonly NimiDesktopIntegrationTargetView[]>
  openHome(section?: NimiDesktopHomeSection): Promise<void>
}

export type NimiIntegrationsSectionProps =
  & PropsRuntime<'settings.section'>
  & PropsLocale<'settings'>
  & InjectFace<NimiIntegrationsSectionInjected>

/** Lists Nimi Home-granted ecosystem integrations and their permitted read/write operations. */
export function NimiIntegrationsSection({ listCatalog, openHome, t }: NimiIntegrationsSectionProps) {
  const [targets, setTargets] = useState<readonly NimiDesktopIntegrationTargetView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await listCatalog()
      setTargets(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('nimi.integrations.loadError'))
    } finally {
      setLoading(false)
    }
  }, [listCatalog, t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className={css.stack}>
      <section className={css.card}>
        <div className={css.headerRow}>
          <div>
            <h3 className={css.title}>{t('nimi.integrations.title')}</h3>
            <p className={css.description}>{t('nimi.integrations.description')}</p>
          </div>
          <div className={css.actions}>
            <Button variant="outline" size="sm" disabled={loading} onClick={() => { void refresh() }}>
              {t('nimi.action.refresh')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => { void openHome('integrations').catch(() => undefined) }}>
              {t('nimi.integrations.manageInHome')}
            </Button>
          </div>
        </div>

        {error && <div className={css.notice} data-tone="error" role="alert">{error}</div>}
        {!loading && !error && targets.length === 0 && (
          <div className={css.notice}>{t('nimi.integrations.empty')}</div>
        )}
      </section>

      {targets.map(target => (
        <section key={target.targetRef} className={css.card}>
          <div className={css.headerRow}>
            <div>
              <h4 className={css.title}>{target.displayName}</h4>
              <p className={css.description}>
                {target.integrationId}
                {target.accountLabel ? ` · ${target.accountLabel}` : ''}
              </p>
            </div>
            <span className={css.pill} data-tone={target.available ? 'ready' : 'error'}>
              {target.available ? t('nimi.integrations.available') : t('nimi.integrations.unavailable')}
            </span>
          </div>

          <div className={css.opList}>
            {target.operations.map(op => (
              <div key={op.name} className={css.opRow}>
                <div>
                  <div className={css.opName}>{op.displayName ?? op.name}</div>
                  {op.description && <div className={css.opDesc}>{op.description}</div>}
                </div>
                <span className={css.pill} data-tone={op.effect === 'write' ? 'write' : 'read'}>
                  {op.effect === 'write' ? t('nimi.integrations.effectWrite') : t('nimi.integrations.effectRead')}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
