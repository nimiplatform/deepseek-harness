import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './DeveloperToolsRow.module.css'

/** Desktop-owned entry into the protected Nimi configuration window. */
export interface NimiSettingsInjected {
  openNimiSettings(): Promise<void>
}

/** Render the Nimi configuration action when the Desktop carrier provides it. */
export function NimiSettingsRow({ t, openNimiSettings }: PropsLocale<'settings'> & InjectFace<NimiSettingsInjected>) {
  const [failed, setFailed] = useState(false)
  return <div className={css.row}>
    <div><div className={css.title}>{t('nimi.settings')}</div>
      <div className={css.description}>{t('nimi.description')}</div>
      {failed && <div role="alert">{t('nimi.settingsError')}</div>}
    </div>
    <Button onClick={() => { setFailed(false); void openNimiSettings().catch(() => { setFailed(true) }) }}>{t('nimi.open')}</Button>
  </div>
}
