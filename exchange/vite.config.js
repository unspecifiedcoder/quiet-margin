import { defineConfig } from 'vite';

// The wasm-bindgen `--target web` prover output (xythum_prover.js,
// xythum_prover_bg.wasm and its generated snippets/**) lives unmodified in
// the standard Vite public directory at public/prover/. Vite serves it at
// same-origin /prover/ in dev and preview and copies it verbatim into the
// production build.
export default defineConfig({
  publicDir: 'public',
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:8790', changeOrigin: false },
    },
  },
  preview: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:8790', changeOrigin: false },
    },
  },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
