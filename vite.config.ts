import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/floorgan/',
  resolve: {
    alias: [
      {
        // ORT's default WebGPU build bundles a 26.8 MB wasm, over Cloudflare's 25 MiB file limit.
        find: /^onnxruntime-web\/webgpu$/,
        replacement: fileURLToPath(
          new URL('./node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs', import.meta.url)
        ),
      },
    ],
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  worker: {
    // The worker lazy-loads one of two ORT builds, which needs code splitting.
    format: 'es',
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
