import { createRoot } from 'react-dom/client';
import { NimiThemeProvider, TooltipProvider } from '@nimiplatform/kit/ui';
import { installNimiShellRuntimeBridge } from '@nimiplatform/kit/shell/renderer/bridge';
import { NimiAppSessionProvider, NimiAppAccessGate } from '@nimiplatform/kit/auth/app';
import { NimiAppChrome } from '@nimiplatform/kit/ui/app-chrome';
import { getTargetAppSession, endTargetAppSession } from './shell/workbench-target-adapter.js';
import { ModelSettings } from './shell/model-settings.js';
import appPackage from '../package.json';
import './styles.css';

installNimiShellRuntimeBridge();
const session = getTargetAppSession();
const root = createRoot(document.getElementById('root')!);
function renderSettings() {
  const language = document.documentElement.lang;
  if (language !== 'zh' && language !== 'en') return;
  document.title = language === 'zh' ? 'Nimi DSH 设置' : 'Nimi DSH settings';
  root.render(<NimiThemeProvider accentPack="nimi-accent"><TooltipProvider><NimiAppSessionProvider session={session}>
    <div className="nimi-settings-window"><NimiAppChrome metadata={{ name: 'Nimi DSH', version: appPackage.version }} locale={language} />
      <NimiAppAccessGate title="Nimi DSH" language={language}>{scope => <ModelSettings language={language} scope={scope} />}</NimiAppAccessGate>
    </div>
  </NimiAppSessionProvider></TooltipProvider></NimiThemeProvider>);
}
window.addEventListener('languagechange', renderSettings);
renderSettings();
void session.start();
if (import.meta.hot) import.meta.hot.dispose(() => { window.removeEventListener('languagechange', renderSettings); endTargetAppSession(session); root.unmount(); });
