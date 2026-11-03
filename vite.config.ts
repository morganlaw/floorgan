import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/floorgan/',
  resolve: {
    alias: [
      {
        // ORT's default WebGPU entry bundles a 26.8 MB wasm binary, over Cloudflare
        // Pages' 25 MiB per-file limit. Use the "extern wasm" build instead; mlWorker.ts
        // points it at a version-pinned copy on jsDelivr via env.wasm.wasmPaths.
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
    // The ML worker lazy-loads one of two ORT builds, which needs code splitting.
    format: 'es',
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
