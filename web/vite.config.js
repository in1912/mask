import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    port: 9910,
    proxy: { '/api': 'http://127.0.0.1:9909' }
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 900 }
});
