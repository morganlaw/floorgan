import {
  parseFloorplanRgbaBuffer,
  type OcrTextBoxPx,
  type ParseOptions,
  type ParseResult,
  type RawDimensionCandidate,
  type RawRoomNameCandidate,
  type SegmentationMasks,
} from './floorplanParser.ts';

export interface ParseInput {
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  options: ParseOptions;
  ocrCandidates: RawDimensionCandidate[];
  useOcrScale: boolean;
  roomCandidates: RawRoomNameCandidate[];
  ocrTextBoxes: OcrTextBoxPx[];
  masks?: SegmentationMasks;
}

export type ParseRequest = ParseInput & { id: number };

export type ParseResponse =
  | { id: number; ok: true; result: ParseResult }
  | { id: number; ok: false; error: string };

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 0;
const pending = new Map<number, { resolve: (r: ParseResult) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./parseWorker.ts', import.meta.url), { type: 'module' });
  } catch (err) {
    console.warn('Parser worker unavailable, parsing on the main thread:', err);
    workerBroken = true;
    return null;
  }
  worker.onmessage = (e: MessageEvent<ParseResponse>) => {
    const data = e.data;
    const cb = pending.get(data.id);
    if (!cb) return;
    pending.delete(data.id);
    if (data.ok) cb.resolve(data.result);
    else cb.reject(new Error(data.error));
  };
  worker.onerror = (e) => {
    console.warn('Parser worker crashed, parsing on the main thread from now on:', e.message);
    workerBroken = true;
    worker?.terminate();
    worker = null;
    const err = new Error(e.message || 'Parser worker crashed');
    for (const cb of pending.values()) cb.reject(err);
    pending.clear();
  };
  return worker;
}

function parseOnMainThread(input: ParseInput): ParseResult {
  const { masks: _masks, ...result } = parseFloorplanRgbaBuffer(
    input.rgba,
    input.w,
    input.h,
    input.options,
    input.ocrCandidates,
    input.useOcrScale,
    input.roomCandidates,
    input.ocrTextBoxes,
    input.masks
  );
  return result;
}

/**
 * Parses the floorplan in a background worker. The input buffers are copied, not
 * transferred, because the caller keeps them for later re-parses.
 */
export async function parseFloorplanInWorker(input: ParseInput): Promise<ParseResult> {
  const w = getWorker();
  if (!w) return parseOnMainThread(input);
  const id = nextId++;
  try {
    return await new Promise<ParseResult>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ ...input, id } satisfies ParseRequest);
    });
  } catch (err) {
    // Only a crashed worker falls back; a parse error would just repeat on the main thread.
    if (workerBroken) return parseOnMainThread(input);
    throw err;
  }
}
