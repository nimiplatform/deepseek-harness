import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NimiThemeProvider, TooltipProvider } from '@nimiplatform/kit/ui';
import { createWebNimiAppSession, type NimiRemoteAppConfig } from '@nimiplatform/kit/auth/app/web';
import { NimiAccountControl, NimiAppAccessGate, NimiAppSessionProvider } from '@nimiplatform/kit/auth/app';
import { RemoteCompanionApp, type RemoteLocale } from '../src/remote/RemoteCompanionApp.js';
import '../src/remote/remote-styles.css';

declare const __NIMI_APP_WEB_CONFIG__: NimiRemoteAppConfig;

const session = createWebNimiAppSession(__NIMI_APP_WEB_CONFIG__);

function detectInitialLocale(): RemoteLocale {
  const saved = window.localStorage.getItem('nimi-dsh-remote-locale');
  if (saved === 'en' || saved === 'zh') return saved;
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function detectInitialTheme(): 'light' | 'dark' {
  const saved = window.localStorage.getItem('nimi-dsh-remote-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function WebCompanionShell() {
  const [language, setLanguage] = useState<RemoteLocale>(detectInitialLocale);
  const [theme, setTheme] = useState<'light' | 'dark'>(detectInitialTheme);

  useEffect(() => {
    window.localStorage.setItem('nimi-dsh-remote-locale', language);
    document.documentElement.lang = language;
    document.title = language === 'zh' ? 'Nimi DSH — 远程控制台' : 'Nimi DSH — Remote Companion';
  }, [language]);

  useEffect(() => {
    window.localStorage.setItem('nimi-dsh-remote-theme', theme);
    document.documentElement.dataset.remoteTheme = theme;
  }, [theme]);

  return (
    <NimiThemeProvider scheme={theme} accentPack="nimi-accent">
      <TooltipProvider>
        <NimiAppSessionProvider session={session}>
          <div className="rc-shell" data-remote-theme={theme}>
            <header className="rc-header">
              <div className="rc-brand">
                <span>Nimi DSH</span>
                <span className="rc-badge">{language === 'zh' ? '远程协作' : 'Remote'}</span>
              </div>
              <div className="rc-header-actions">
                <button
                  type="button"
                  className="rc-btn"
                  onClick={() => { setLanguage(prev => (prev === 'en' ? 'zh' : 'en')); }}
                >
                  {language === 'en' ? '中文' : 'EN'}
                </button>
                <button
                  type="button"
                  className="rc-btn"
                  onClick={() => { setTheme(prev => (prev === 'light' ? 'dark' : 'light')); }}
                >
                  {theme === 'light' ? (language === 'zh' ? '深色' : 'Dark') : (language === 'zh' ? '浅色' : 'Light')}
                </button>
                <NimiAccountControl hideSignedOut language={language} />
              </div>
            </header>
            <NimiAppAccessGate title="Nimi DSH" language={language}>
              {scope => <RemoteCompanionApp scope={scope} language={language} />}
            </NimiAppAccessGate>
          </div>
        </NimiAppSessionProvider>
      </TooltipProvider>
    </NimiThemeProvider>
  );
}

const rootEl = document.getElementById('root')!;
const reactRoot = createRoot(rootEl);
reactRoot.render(
  <React.StrictMode>
    <WebCompanionShell />
  </React.StrictMode>,
);
void session.start();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    session.dispose();
    reactRoot.unmount();
  });
}
