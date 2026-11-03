// ONNX Runtime lives only in this worker.
// Try WebGPU (FP16 model) if available; on any error or timeout fall back to the CPU
// (WASM, INT8 model). Each ORT build is loaded lazily, so a browser only downloads
// what it uses.
import type * as OrtTypes from 'onnxruntime-web';
import {
  prepareModelInputTensor,
  logitsToSegmentationMasks,
  fetchModelParts,
  ML_MODEL_INPUT_SIZE,
  CPU_MODEL_PART_URLS,
  GPU_MODEL_PART_URLS,
  type MlBackend,
} from './mlSegmenter.ts';
import type { ParseOptions, OcrTextBoxPx } from './floorplanParser.ts';

type Ort = typeof OrtTypes;

const N = ML_MODEL_INPUT_SIZE;

interface LoadedSession {
  ort: Ort;
  session: OrtTypes.InferenceSession;
  backend: MlBackend;
}

/**
 * WebGPU setup (session creation + shader warm-up) normally takes 2-4 s. On some
 * GPU/driver combinations it hangs instead of throwing, so it gets a time limit.
 */
const WEBGPU_SETUP_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

let loaded: LoadedSession | null = null;
let loadingPromise: Promise<LoadedSession> | null = null;

async function createWebGpuSession(): Promise<LoadedSession> {
  // Aliased in vite.config.ts to ORT's "extern wasm" WebGPU build so its 26.8 MB
  // runtime binary isn't bundled into dist/ (Cloudflare's per-file limit is 25 MiB);
  // it loads from jsDelivr, pinned to the installed ORT version.
  const ort = (await import('onnxruntime-web/webgpu')) as unknown as Ort;
  const cdn = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web ?? ort.env.versions.common}/dist/`;
  ort.env.wasm.wasmPaths = {
    mjs: `${cdn}ort-wasm-simd-threaded.asyncify.mjs`,
    wasm: `${cdn}ort-wasm-simd-threaded.asyncify.wasm`,
  };
  // Use the GPU that's already driving the display. On dual-GPU laptops, waking the
  // discrete GPU can make the OS switch graphics and stall WebGPU; on single-GPU
  // devices (phones, Apple Silicon, most desktops) this has no effect.
  ort.env.webgpu.powerPreference = 'low-power';

  // Download outside the time limit so a slow connection isn't mistaken for a GPU hang.
  const model = await fetchModelParts(GPU_MODEL_PART_URLS);

  const session = await withTimeout(
    (async () => {
      const s = await ort.InferenceSession.create(model, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
      // The first run compiles shaders (~1-2 s); do it now while the dialog is open.
      const dummy = new ort.Tensor('float32', new Float32Array(3 * N * N).fill(1), [1, 3, N, N]);
      await s.run({ input_rgb: dummy });
      return s;
    })(),
    WEBGPU_SETUP_TIMEOUT_MS,
    'WebGPU setup'
  );
  return { ort, session, backend: 'webgpu' };
}

async function createWasmSession(): Promise<LoadedSession> {
  const ort = (await import('onnxruntime-web/wasm')) as unknown as Ort;
  const canUseThreads = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  ort.env.wasm.numThreads = canUseThreads ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

  const model = await fetchModelParts(CPU_MODEL_PART_URLS);
  const session = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return { ort, session, backend: 'wasm' };
}

/** Try WebGPU if the browser has it; on any error or timeout, use the CPU (WASM). */
async function getOrInitSession(): Promise<LoadedSession> {
  if (loaded) return loaded;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    if ('gpu' in navigator) {
      try {
        loaded = await createWebGpuSession();
        return loaded;
      } catch (err) {
        console.warn('WebGPU failed, using CPU instead:', err);
      }
    }
    loaded = await createWasmSession();
    return loaded;
  })();

  try {
    return await loadingPromise;
  } catch (err) {
    loadingPromise = null;
    throw err;
  }
}

async function releaseSession(): Promise<void> {
  if (loadingPromise) {
    try {
      await loadingPromise;
    } catch {}
  }
  if (loaded) {
    try {
      await loaded.session.release();
    } catch (err) {
      console.warn('Worker error releasing ONNX session:', err);
    }
    loaded = null;
    loadingPromise = null;
  }
}

async function runLogits(
  { ort, session }: LoadedSession,
  rgba: Uint8Array,
  w: number,
  h: number,
  invert: boolean
): Promise<Float32Array> {
  const input = prepareModelInputTensor(rgba, w, h, N, invert);
  const outputs = await session.run({
    input_rgb: new ort.Tensor('float32', input, [1, 3, N, N]),
  });
  return (outputs.logits ?? Object.values(outputs)[0]).data as Float32Array;
}

/** Horizontally mirrors an RGBA image of size w×h. */
function flipRgbaHorizontal(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const s = row + x * 4;
      const d = row + (w - 1 - x) * 4;
      out[d] = rgba[s];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2];
      out[d + 3] = rgba[s + 3];
    }
  }
  return out;
}

/**
 * Logits for the image. On WebGPU (cheap) this averages the normal pass with a
 * horizontally flipped pass (test-time augmentation); on WASM it is single-pass.
 */
async function segmentLogits(
  s: LoadedSession,
  rgba: Uint8Array,
  w: number,
  h: number,
  invert: boolean
): Promise<Float32Array> {
  const logits = await runLogits(s, rgba, w, h, invert);
  if (s.backend !== 'webgpu') return logits;

  try {
    const flipped = await runLogits(s, flipRgbaHorizontal(rgba, w, h), w, h, invert);
    const planeSize = N * N;
    const copyW = Math.min(w, N);
    const copyH = Math.min(h, N);
    const merged = new Float32Array(logits);
    for (let c = 0; c < 4; c++) {
      const cOff = c * planeSize;
      for (let y = 0; y < copyH; y++) {
        const row = cOff + y * N;
        for (let x = 0; x < copyW; x++) {
          merged[row + x] = (logits[row + x] + flipped[row + (copyW - 1 - x)]) * 0.5;
        }
      }
    }
    return merged;
  } catch (err) {
    console.warn('Flip TTA failed, using single pass:', err);
    return logits;
  }
}

let executionQueue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent) => {
  const { id, type, payload } = e.data;

  executionQueue = executionQueue
    .then(async () => {
      try {
        if (type === 'WARM') {
          const s = await getOrInitSession();
          self.postMessage({ id, type: 'WARMED', payload: { backend: s.backend } });
        } else if (type === 'RELEASE') {
          await releaseSession();
          self.postMessage({ id, type: 'RELEASED' });
        } else if (type === 'SEGMENT') {
          const { rgba, w, h, options, ocrTextBoxes } = payload as {
            rgba: Uint8Array;
            w: number;
            h: number;
            options: ParseOptions;
            ocrTextBoxes: OcrTextBoxPx[];
          };

          const s = await getOrInitSession();
          const logits = await segmentLogits(s, rgba, w, h, options.invert);
          const masks = logitsToSegmentationMasks(logits, rgba, w, h, options, ocrTextBoxes, N);

          const transferables: Transferable[] = [
            masks.structuralMask.buffer,
            masks.rawMask.buffer,
            masks.detailMask.buffer,
          ];
          if (masks.doorMask) transferables.push(masks.doorMask.buffer);
          if (masks.windowMask) transferables.push(masks.windowMask.buffer);

          (postMessage as (message: any, transfer: Transferable[]) => void)(
            { id, type: 'SEGMENT_SUCCESS', payload: masks },
            transferables
          );
        }
      } catch (err) {
        self.postMessage({
          id,
          type: 'ERROR',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
    .catch((err) => {
      console.error('Worker internal queue uncaught error:', err);
    });
};
