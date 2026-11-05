import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const web = resolve(__dirname, 'web');

export default defineConfig({
  root: web,
  // `npm run dev` talks to `go run ./cmd/server` on :8080.
  server: { proxy: { '/api': 'http://localhost:8080' } },
  build: {
    outDir: resolve(web, 'dist'),
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      input: {
        index: resolve(web, 'index.html'),
        playtest: resolve(web, 'play-test/index.html'),
        board: resolve(web, 'board.html'),
        admin: resolve(web, 'admin.html'),
        privacy: resolve(web, 'privacy.html'),
      },
    },
  },
  test: {
    root: __dirname,
    include: ['web/src/**/*.test.ts'],
  },
} as any);
