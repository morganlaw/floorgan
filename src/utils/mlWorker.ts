import type * as OrtTypes from 'onnxruntime-web';
import {
  prepareModelInputTensor,
  logitsToSegmentationMasks,
  fetchModelParts,
  withTimeout,
  ML_MODEL_INPUT_SIZE,
  CPU_MODEL_PART_URLS,
  GPU_MODEL_PART_URLS,
  canUseWebGpu,
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

// Some GPU/driver combinations hang here instead of throwing.
const WEBGPU_SETUP_TIMEOUT_MS = 15_000;

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  console.debug(`[ml] ${label}: ${Math.round(performance.now() - start)} ms`);
  return result;
}

let loaded: LoadedSession | null = null;
let loadingPromise: Promise<LoadedSession> | null = null;

async function createWebGpuSession(): Promise<LoadedSession> {
  // The runtime wasm is too big for Cloudflare (see vite.config.ts); load it from jsDelivr.
  const ort = (await import('onnxruntime-web/webgpu')) as unknown as Ort;
  const cdn = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web ?? ort.env.versions.common}/dist/`;
  ort.env.wasm.wasmPaths = {
    mjs: `${cdn}ort-wasm-simd-threaded.asyncify.mjs`,
    wasm: `${cdn}ort-wasm-simd-threaded.asyncify.wasm`,
  };
  // Waking a discrete GPU on dual-GPU laptops can stall WebGPU while the OS switches graphics.
  ort.env.webgpu.powerPreference = 'low-power';

  // Download outside the time limit so a slow connection isn't mistaken for a GPU hang.
  const model = await timed('fetch GPU model', () => fetchModelParts(GPU_MODEL_PART_URLS));

  const session = await withTimeout(
    (async () => {
      const s = await timed('create WebGPU session', () =>
        ort.InferenceSession.create(model, {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all',
        })
      );
      // The first run compiles shaders (~1-2 s).
      const dummy = new ort.Tensor('float32', new Float32Array(3 * N * N).fill(1), [1, 3, N, N]);
      await timed('warm-up run', () => s.run({ input_rgb: dummy }));
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

async function getOrInitSession(): Promise<LoadedSession> {
  if (loaded) return loaded;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    if (await canUseWebGpu()) {
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

// Flip test-time augmentation only on WebGPU; on the CPU it would double a ~15 s run.
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
          const logits = await timed(`segment (${s.backend})`, () =>
            segmentLogits(s, rgba, w, h, options.invert)
          );
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
