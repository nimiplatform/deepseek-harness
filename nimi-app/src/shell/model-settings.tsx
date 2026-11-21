import { useState } from 'react';
import { NimiAccountControl, useNimiAppSession, type NimiAppScope } from '@nimiplatform/kit/auth/app';
import { Button } from '@nimiplatform/kit/ui';
import { AppModelConfigSurface } from '@nimiplatform/kit/features/model-config/ui';
import { openDesktopIntent } from '@nimiplatform/kit/shell/renderer/bridge';
import { appId } from './auth/app-identity.js';

const labels = {
  en: { title: 'Models & access', refresh: 'Refresh access', connected: 'Connected to Nimi', home: 'Open App settings in Home' },
  zh: { title: '模型与访问', refresh: '刷新访问状态', connected: '已连接到 Nimi', home: '在 Home 中打开应用设置' },
};

export function ModelSettings({ language, scope }: { language: 'en' | 'zh'; scope: NimiAppScope }) {
  const { session } = useNimiAppSession();
  const text = labels[language];
  const [error, setError] = useState('');
  async function openHome(section?: 'ai-models') {
    setError('');
    try {
      const result = await openDesktopIntent({ intent: { kind: 'open-apps', appId, ...(section ? { section } : {}) } });
      if (result.status !== 'accepted') throw new Error(result.reasonCode);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <section className="nimi-settings">
    <header className="nimi-heading"><h1>{text.title}</h1><Button tone="secondary" onClick={() => void session.recheck()}>{text.refresh}</Button></header>
    <NimiAccountControl language={language} />
    <div className="nimi-access"><span role="status">{text.connected}</span><Button tone="secondary" onClick={() => void openHome()}>{text.home}</Button></div>
    {error && <p role="alert">{error}</p>}
    <AppModelConfigSurface scope={scope} appId={appId} capabilityContracts={['text.generate']} language={language}
      onOpenOwnerConfiguration={() => void openHome('ai-models')} />
  </section>;
}
