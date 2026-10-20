// 构建产物进 dist/<时间戳>/（服务端 latestDist() 挑最新目录，升级包约定与游巷/教材同款）
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs';
import path from 'node:path';

const distRoot = path.resolve(__dirname, 'dist');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
fs.mkdirSync(distRoot, { recursive: true });
fs.writeFileSync(path.join(distRoot, '.latest'), stamp);

export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    port: 9910,
    proxy: { '/api': 'http://127.0.0.1:9909' }
  },
  build: { outDir: `dist/${stamp}`, emptyOutDir: true, chunkSizeWarningLimit: 900 }
});
