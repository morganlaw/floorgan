import * as ort from 'onnxruntime-web';
import {
  segmentFloorplanOtsu,
  type OcrTextBoxPx,
  type ParseOptions,
  type RawSegment,
  type SegmentationMasks,
} from './floorplanParser.ts';

export const ML_MODEL_INPUT_SIZE = 768;
export const ML_MODEL_NUM_PARTS = 3;

ort.env.wasm.simd = 'relaxed';

const viteBaseUrl =
  typeof import.meta !== 'undefined' &&
  (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL
    ? (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL
    : '/';

export const DEFAULT_MODEL_URL = `${viteBaseUrl.endsWith('/') ? viteBaseUrl : `${viteBaseUrl}/`}models/floorplan-seg-v1.onnx`;

export const MODEL_CACHE_NAME = 'floorgan-models-v1';
export const MODEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function fetchShardWithCache(url: string): Promise<Uint8Array> {
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(MODEL_CACHE_NAME);
      const cached = await cache.match(url);
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
      if (!resp.ok) {
        throw new Error(`Failed to fetch model shard ${url}: ${resp.status}`);
      }
      const data = await resp.arrayBuffer();
      const headers = new Headers(resp.headers);
      headers.set('x-floorgan-cached-at', String(Date.now()));
      const toCache = new Response(data, { headers });
      await cache.put(url, toCache);
      return new Uint8Array(data);
    } catch (err) {
      console.warn('CacheStorage failed for shard, falling back to direct fetch:', err);
    }
  }

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch model shard ${url}: ${resp.status}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

export async function prewarmModelCache(modelUrl = DEFAULT_MODEL_URL): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(MODEL_CACHE_NAME);
  await Promise.all(
    Array.from({ length: ML_MODEL_NUM_PARTS }, async (_, idx) => {
      const shardUrl = `${modelUrl}.part${idx}`;
      const match = await cache.match(shardUrl);
      if (!match) {
        const resp = await fetch(shardUrl);
        if (resp.ok) {
          const headers = new Headers(resp.headers);
          headers.set('x-floorgan-cached-at', String(Date.now()));
          const toCache = new Response(await resp.arrayBuffer(), { headers });
          await cache.put(shardUrl, toCache);
        }
      }
    })
  );
}

let cachedSession: ort.InferenceSession | null = null;
let sessionPromise: Promise<ort.InferenceSession> | null = null;

export function prepareModelInputTensor(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  targetSize = ML_MODEL_INPUT_SIZE
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
      input[dIdx] = r;
      input[planeSize + dIdx] = g;
      input[2 * planeSize + dIdx] = b;
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
      } else if (pWall >= 0.42 || (l1 > l0 && l1 >= l2 && l1 >= l3)) {
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

export async function getBrowserMlSession(
  modelUrl = DEFAULT_MODEL_URL
): Promise<ort.InferenceSession> {
  if (cachedSession) return cachedSession;
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    const canUseThreads =
      typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
    ort.env.wasm.numThreads = canUseThreads
      ? Math.min(4, navigator.hardwareConcurrency || 2)
      : 1;

    const partBuffers = await Promise.all(
      Array.from({ length: ML_MODEL_NUM_PARTS }, (_, idx) =>
        fetchShardWithCache(`${modelUrl}.part${idx}`)
      )
    );

    const totalLen = partBuffers.reduce((acc, b) => acc + b.byteLength, 0);
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of partBuffers) {
      combined.set(part, offset);
      offset += part.byteLength;
    }

    // 1. Attempt hardware-accelerated WebGPU if available in current scope
    if (
      typeof navigator !== 'undefined' &&
      'gpu' in navigator &&
      Boolean(navigator.gpu)
    ) {
      try {
        const session = await ort.InferenceSession.create(combined.buffer, {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all',
        });
        cachedSession = session;
        return session;
      } catch (err) {
        console.warn('WebGPU execution provider failed, falling back to WASM:', err);
      }
    }

    // 2. Fallback to SIMD multi-threaded WASM
    const session = await ort.InferenceSession.create(combined.buffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    cachedSession = session;
    return session;
  })();

  try {
    return await sessionPromise;
  } catch (err) {
    sessionPromise = null;
    throw err;
  }
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
      for (const [_, cb] of pendingCallbacks) {
        cb.reject(err);
      }
      pendingCallbacks.clear();
      terminateMlWorker();
    };
  }
  return activeWorker;
}

export function terminateMlWorker(): void {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
    for (const [_, cb] of pendingCallbacks) {
      cb.reject(new Error('ML inference cancelled and worker terminated'));
    }
    pendingCallbacks.clear();
  }
}

export async function prewarmBrowserMl(modelUrl = DEFAULT_MODEL_URL): Promise<void> {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return;
  const worker = getOrCreateWorker();
  const id = msgId++;
  return new Promise((resolve, reject) => {
    pendingCallbacks.set(id, { resolve, reject });
    worker.postMessage({ id, type: 'WARM', payload: { modelUrl } });
  });
}

export async function releaseBrowserMlSession(): Promise<void> {
  if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
    if (activeWorker) {
      terminateMlWorker();
    }
  }

  if (sessionPromise) {
    try {
      await sessionPromise;
    } catch {}
  }
  if (cachedSession) {
    try {
      await cachedSession.release();
    } catch (err) {
      console.warn('Error releasing main-thread ONNX session:', err);
    }
    cachedSession = null;
    sessionPromise = null;
  }
}

export async function segmentFloorplanMlBrowser(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  options: ParseOptions,
  ocrTextBoxes: OcrTextBoxPx[] = [],
  modelUrl = DEFAULT_MODEL_URL
): Promise<SegmentationMasks> {
  if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
    const worker = getOrCreateWorker();
    const id = msgId++;
    const rawRgba = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingCallbacks.has(id)) {
          pendingCallbacks.delete(id);
          reject(new Error('ML segmentation timed out'));
        }
      }, 30000);

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
        payload: { rgba: rawRgba, w, h, options, ocrTextBoxes, modelUrl },
      });
    });
  }

  const session = await getBrowserMlSession(modelUrl);
  const inputData = prepareModelInputTensor(rgba, w, h, ML_MODEL_INPUT_SIZE);
  const inputTensor = new ort.Tensor('float32', inputData, [
    1,
    3,
    ML_MODEL_INPUT_SIZE,
    ML_MODEL_INPUT_SIZE,
  ]);

  const outputs = await session.run({ input_rgb: inputTensor });
  const logitsTensor = outputs.logits ?? Object.values(outputs)[0];
  const logitsData = logitsTensor.data as Float32Array;

  return logitsToSegmentationMasks(
    logitsData,
    rgba,
    w,
    h,
    options,
    ocrTextBoxes,
    ML_MODEL_INPUT_SIZE
  );
}
