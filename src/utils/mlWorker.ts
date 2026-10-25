import * as ort from 'onnxruntime-web/wasm';
import {
  prepareModelInputTensor,
  logitsToSegmentationMasks,
  ML_MODEL_INPUT_SIZE,
  ML_MODEL_NUM_PARTS,
  DEFAULT_MODEL_URL,
} from './mlSegmenter.ts';
import type { ParseOptions, OcrTextBoxPx } from './floorplanParser.ts';

ort.env.wasm.simd = 'relaxed';

const MODEL_CACHE_NAME = 'floorgan-models-v1';
const MODEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function fetchShardWithCache(url: string): Promise<Uint8Array> {
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
      console.warn('CacheStorage failed for shard, falling back to network:', err);
    }
  }

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch model shard ${url}: ${resp.status}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

let cachedSession: ort.InferenceSession | null = null;
let sessionPromise: Promise<ort.InferenceSession> | null = null;

async function getOrInitSession(modelUrl = DEFAULT_MODEL_URL): Promise<ort.InferenceSession> {
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

async function releaseSession(): Promise<void> {
  if (sessionPromise) {
    try {
      await sessionPromise;
    } catch {}
  }
  if (cachedSession) {
    try {
      await cachedSession.release();
    } catch (err) {
      console.warn('Worker error releasing ONNX session:', err);
    }
    cachedSession = null;
    sessionPromise = null;
  }
}

self.onmessage = async (e: MessageEvent) => {
  const { id, type, payload } = e.data;

  try {
    if (type === 'WARM') {
      await getOrInitSession(payload?.modelUrl);
      self.postMessage({ id, type: 'WARMED' });
    } else if (type === 'RELEASE') {
      await releaseSession();
      self.postMessage({ id, type: 'RELEASED' });
    } else if (type === 'SEGMENT') {
      const { rgba, w, h, options, ocrTextBoxes, modelUrl } = payload as {
        rgba: Uint8Array;
        w: number;
        h: number;
        options: ParseOptions;
        ocrTextBoxes: OcrTextBoxPx[];
        modelUrl?: string;
      };

      const session = await getOrInitSession(modelUrl);
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

      const masks = logitsToSegmentationMasks(
        logitsData,
        rgba,
        w,
        h,
        options,
        ocrTextBoxes,
        ML_MODEL_INPUT_SIZE
      );

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
};
