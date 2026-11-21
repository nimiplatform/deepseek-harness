import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({ base: './', plugins: [react(), tailwindcss()],
  build: { outDir: '../apps/desktop/lib/nimi', emptyOutDir: true },
  resolve: { dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
});
