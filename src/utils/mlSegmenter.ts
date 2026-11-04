import {
  segmentFloorplanOtsu,
  prewarmOcrWorker,
  terminateOcrWorker,
  type OcrTextBoxPx,
  type ParseOptions,
  type RawSegment,
  type SegmentationMasks,
} from './floorplanParser.ts';

export const ML_MODEL_INPUT_SIZE = 768;
export const ML_INFERENCE_TIMEOUT_MS = 90_000;

const viteBaseUrl =
  typeof import.meta !== 'undefined' &&
  (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL
    ? (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL
    : '/';

const modelsBase = `${viteBaseUrl.endsWith('/') ? viteBaseUrl : `${viteBaseUrl}/`}models/`;

// Sharded because Cloudflare Pages rejects files over 25 MiB.
const partUrls = (name: string, parts: number) =>
  Array.from({ length: parts }, (_, i) => `${modelsBase}${name}.part${i}`);

export const CPU_MODEL_PART_URLS = partUrls('floorplan-seg-v1.onnx', 3);
// WebGPU has no kernels for the INT8 model's integer ops (they run on the CPU per
// layer), so the GPU path uses FP16.
export const GPU_MODEL_PART_URLS = partUrls('floorplan-seg-v1-fp16.onnx', 6);

export type MlBackend = 'webgpu' | 'wasm';

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
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

// Unchanged from the previous release so returning visitors keep their cached CPU shards.
export const MODEL_CACHE_NAME = 'floorgan-models-v1';
export const MODEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class ModelFetchError extends Error {}

// Some hosts answer unknown paths with an HTML page (status 200); never cache that as the model.
function assertModelResponse(resp: Response, url: string): void {
  if (!resp.ok) {
    throw new ModelFetchError(`Failed to fetch model ${url}: HTTP ${resp.status}`);
  }
  if (isHtmlResponse(resp)) {
    throw new ModelFetchError(`Model URL ${url} returned an HTML page instead of the model`);
  }
}

function isHtmlResponse(resp: Response): boolean {
  return (resp.headers.get('content-type') || '').toLowerCase().includes('text/html');
}

export async function fetchModelWithCache(url: string): Promise<Uint8Array> {
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(MODEL_CACHE_NAME);
      let cached = await cache.match(url);
      if (cached && isHtmlResponse(cached)) {
        await cache.delete(url);
        cached = undefined;
      }
      if (cached) {
        const cachedAt = cached.headers.get('x-floorgan-cached-at');
        const isExpired = cachedAt && Date.now() - Number(cachedAt) > MODEL_CACHE_TTL_MS;
        if (!isExpired) {
          return new Uint8Array(await cached.arrayBuffer());
        }
        try {
          const headResp = await fetch(url, { method: 'HEAD' });
          const newEtag = headResp.headers.get('etag');
          const oldEtag = cached.headers.get('etag');
          if (newEtag && oldEtag && newEtag === oldEtag) {
            const headers = new Headers(cached.headers);
            headers.set('x-floorgan-cached-at', String(Date.now()));
            const refreshed = new Response(cached.body, { headers });
            await cache.put(url, refreshed.clone());
            return new Uint8Array(await refreshed.arrayBuffer());
          }
        } catch {
          return new Uint8Array(await cached.arrayBuffer());
        }
      }

      const resp = await fetch(url);
      assertModelResponse(resp, url);
      const data = await resp.arrayBuffer();
      const headers = new Headers(resp.headers);
      headers.set('x-floorgan-cached-at', String(Date.now()));
      const toCache = new Response(data, { headers });
      await cache.put(url, toCache);
      return new Uint8Array(data);
    } catch (err) {
      if (err instanceof ModelFetchError) throw err;
      console.warn('CacheStorage failed for model, falling back to direct fetch:', err);
    }
  }

  const resp = await fetch(url);
  assertModelResponse(resp, url);
  return new Uint8Array(await resp.arrayBuffer());
}

export async function fetchModelParts(urls: string[]): Promise<Uint8Array> {
  const parts = await Promise.all(urls.map((u) => fetchModelWithCache(u)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

export async function purgeStaleModelCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((n) => n.startsWith('floorgan-models-') && n !== MODEL_CACHE_NAME)
      .map((n) => caches.delete(n))
  );
}

// Only purges old caches; models load on import intent (see prewarmImportPipeline).
export async function prewarmModelCache(): Promise<void> {
  await purgeStaleModelCaches();
}

export function prepareModelInputTensor(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  targetSize = ML_MODEL_INPUT_SIZE,
  invert = false
): Float32Array {
  const planeSize = targetSize * targetSize;
  const input = new Float32Array(3 * planeSize);
  input.fill(1.0);

  const copyW = Math.min(w, targetSize);
  const copyH = Math.min(h, targetSize);

  for (let y = 0; y < copyH; y++) {
    const srcRow = y * w * 4;
    const dstRow = y * targetSize;
    for (let x = 0; x < copyW; x++) {
      const sOff = srcRow + x * 4;
      const dIdx = dstRow + x;
      const a = rgba[sOff + 3] / 255;
      const r = (rgba[sOff] * a + 255 * (1 - a)) / 255;
      const g = (rgba[sOff + 1] * a + 255 * (1 - a)) / 255;
      const b = (rgba[sOff + 2] * a + 255 * (1 - a)) / 255;
      // The model was trained on dark lines over light paper, so blueprints are inverted.
      input[dIdx] = invert ? 1 - r : r;
      input[planeSize + dIdx] = invert ? 1 - g : g;
      input[2 * planeSize + dIdx] = invert ? 1 - b : b;
    }
  }

  return input;
}

export function logitsToSegmentationMasks(
  logitsData: Float32Array,
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  options: ParseOptions,
  ocrTextBoxes: OcrTextBoxPx[] = [],
  modelSize = ML_MODEL_INPUT_SIZE
): SegmentationMasks {
  const baseMasks = segmentFloorplanOtsu(rgba, w, h, options, ocrTextBoxes);

  const planeSize = modelSize * modelSize;
  const structuralMask = new Uint8Array(w * h);
  const windowMask = new Uint8Array(w * h);
  const doorMask = new Uint8Array(w * h);

  const copyW = Math.min(w, modelSize);
  const copyH = Math.min(h, modelSize);

  for (let y = 0; y < copyH; y++) {
    const mRow = y * modelSize;
    const outRow = y * w;
    for (let x = 0; x < copyW; x++) {
      const mIdx = mRow + x;
      const outIdx = outRow + x;

      const l0 = logitsData[mIdx];
      const l1 = logitsData[planeSize + mIdx];
      const l2 = logitsData[2 * planeSize + mIdx];
      const l3 = logitsData[3 * planeSize + mIdx];

      const maxL = Math.max(l0, l1, l2, l3);
      const e0 = Math.exp(l0 - maxL);
      const e1 = Math.exp(l1 - maxL);
      const e2 = Math.exp(l2 - maxL);
      const e3 = Math.exp(l3 - maxL);
      const sumE = e0 + e1 + e2 + e3;

      const pWall = e1 / sumE;
      const pWin = e2 / sumE;
      const pDoor = e3 / sumE;

      if (pDoor >= 0.38 && pDoor >= pWin && pDoor >= pWall * 0.85) {
        doorMask[outIdx] = 1;
      } else if (pWin >= 0.38 && pWin >= pDoor && pWin >= pWall * 0.85) {
        windowMask[outIdx] = 1;
      } else if (pWall >= 0.70 || (pWall >= 0.40 && baseMasks.rawMask[outIdx])) {
        structuralMask[outIdx] = 1;
      }
    }
  }

  let thickSum = 0;
  let thickCount = 0;
  for (let y = 0; y < h; y += 4) {
    const row = y * w;
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (structuralMask[row + x]) {
        run++;
      } else if (run > 0) {
        if (run >= 3 && run <= 22) {
          thickSum += run;
          thickCount++;
        }
        run = 0;
      }
    }
  }

  const dominantWallThickPx =
    thickCount > 10
      ? Math.max(4, Math.min(16, Math.round(thickSum / thickCount)))
      : baseMasks.dominantWallThickPx;

  const winBandsPx: RawSegment[] = [];

  return {
    width: w,
    height: h,
    structuralMask,
    rawMask: baseMasks.rawMask,
    detailMask: baseMasks.detailMask,
    doorMask,
    windowMask,
    winBandsPx,
    dominantWallThickPx,
    autoKernelPx: Math.max(2, Math.min(5, Math.round(dominantWallThickPx * 0.45))),
    computedThreshold: baseMasks.computedThreshold,
  };
}

let activeWorker: Worker | null = null;
let msgId = 1;
const pendingCallbacks = new Map<
  number,
  { resolve: (val: any) => void; reject: (err: any) => void }
>();

function getOrCreateWorker(): Worker {
  if (!activeWorker) {
    activeWorker = new Worker(new URL('./mlWorker.ts', import.meta.url), {
      type: 'module',
    });
    activeWorker.onmessage = (e: MessageEvent) => {
      const { id, type, payload, error } = e.data;
      const cb = pendingCallbacks.get(id);
      if (cb) {
        pendingCallbacks.delete(id);
        if (type === 'ERROR') {
          cb.reject(new Error(error));
        } else {
          cb.resolve(payload);
        }
      }
    };
    activeWorker.onerror = (err) => {
      console.error('ML Background Worker Error:', err);
      const error = new Error(err.message || 'ML worker crashed');
      for (const [_, cb] of pendingCallbacks) {
        cb.reject(error);
      }
      pendingCallbacks.clear();
      terminateMlWorker();
    };
  }
  return activeWorker;
}

export function terminateMlWorker(): void {
  warmPromise = null;
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
    for (const [_, cb] of pendingCallbacks) {
      cb.reject(new Error('ML inference cancelled and worker terminated'));
    }
    pendingCallbacks.clear();
  }
}

let warmPromise: Promise<MlBackend> | null = null;

export function prewarmBrowserMl(): Promise<MlBackend> {
  cancelScheduledRelease();
  if (warmPromise) return warmPromise;
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    return Promise.reject(new Error('Web Workers are not available in this browser'));
  }
  const worker = getOrCreateWorker();
  const id = msgId++;
  const p = new Promise<MlBackend>((resolve, reject) => {
    pendingCallbacks.set(id, {
      resolve: (payload: { backend: MlBackend }) => resolve(payload.backend),
      reject,
    });
    worker.postMessage({ id, type: 'WARM' });
  });
  warmPromise = p;
  p.catch(() => {
    if (warmPromise === p) warmPromise = null;
  });
  return p;
}

const IDLE_RELEASE_MS = 5 * 60 * 1000;

let releaseTimer: ReturnType<typeof setTimeout> | null = null;

function cancelScheduledRelease(): void {
  if (releaseTimer !== null) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
}

export function scheduleImportRelease(): void {
  cancelScheduledRelease();
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    releaseBrowserMlSession().catch(() => {});
    terminateOcrWorker().catch(() => {});
  }, IDLE_RELEASE_MS);
}

// Release the session (and the GPU device) before terminating the worker.
export async function releaseBrowserMlSession(): Promise<void> {
  cancelScheduledRelease();
  warmPromise = null;
  if (!activeWorker) return;
  const worker = activeWorker;
  const id = msgId++;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000);
    pendingCallbacks.set(id, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: () => {
        clearTimeout(timer);
        resolve();
      },
    });
    worker.postMessage({ id, type: 'RELEASE' });
  });
  if (activeWorker === worker) terminateMlWorker();
}

export async function segmentFloorplanMlBrowser(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  options: ParseOptions,
  ocrTextBoxes: OcrTextBoxPx[] = []
): Promise<SegmentationMasks> {
  // Wait for the model load first so a slow download isn't reported as an inference timeout.
  await prewarmBrowserMl();

  const worker = getOrCreateWorker();
  const id = msgId++;
  const rawRgba = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingCallbacks.has(id)) {
        pendingCallbacks.delete(id);
        reject(new Error('ML segmentation timed out'));
        // The worker is still busy with this run; terminate it so later requests
        // aren't queued behind it.
        terminateMlWorker();
      }
    }, ML_INFERENCE_TIMEOUT_MS);

    pendingCallbacks.set(id, {
      resolve: (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    worker.postMessage({
      id,
      type: 'SEGMENT',
      payload: { rgba: rawRgba, w, h, options, ocrTextBoxes },
    });
  });
}

async function isModelCached(): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const hits = await Promise.all(
      [GPU_MODEL_PART_URLS[0], CPU_MODEL_PART_URLS[0]].map((u) => cache.match(u))
    );
    return hits.some(Boolean);
  } catch {
    return false;
  }
}

export async function prewarmImportPipeline(trigger: 'hover' | 'press'): Promise<void> {
  if (trigger === 'hover' && !(await isModelCached())) return;
  prewarmBrowserMl().catch(() => {});
  prewarmOcrWorker().catch(() => {});
  scheduleImportRelease();
}
