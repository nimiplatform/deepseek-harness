import { resolve } from 'node:path';
import { defineConfig, loadEnv, mergeConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nimiWebViteConfig } from '@nimiplatform/app-tools/web';

export default defineConfig(({ command, mode }) => {
  const loaded = { ...loadEnv(mode, import.meta.dirname, ''), ...process.env };
  const release = mode === 'web-release';
  const env = !release && !loaded.NIMI_DEV_REALM
    ? { ...loaded, NIMI_DEV_REALM: 'local' }
    : loaded;

  return mergeConfig({
    root: resolve(import.meta.dirname, 'web'),
    publicDir: resolve(import.meta.dirname, 'web/public'),
    base: './',
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve(import.meta.dirname, 'dist-web'),
      emptyOutDir: true,
    },
    server: {
      watch: { ignored: ['**/.nimi/local/**', '**/.tmp/**'] },
    },
    resolve: {
      dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    },
  }, nimiWebViteConfig({
    root: import.meta.dirname,
    env,
    serve: command === 'serve',
    release,
  }));
});
