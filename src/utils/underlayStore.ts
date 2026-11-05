import { useEffect, useSyncExternalStore } from 'react';

/**
 * Underlay images live in IndexedDB as binary blobs, keyed by an id that the floorplan state
 * references. localStorage (≈5 MB, synchronous) then only has to hold the small plan JSON.
 */

const DB_NAME = 'floorgan-underlays';
const STORE = 'images';

interface StoredImage {
  id: string;
  blob: Blob;
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open IndexedDB'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putImage(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put({ id, blob, createdAt: Date.now() } satisfies StoredImage);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
  });
}

async function getImage(id: string): Promise<Blob | undefined> {
  const db = await openDb();
  const record = await requestToPromise<StoredImage | undefined>(
    db.transaction(STORE, 'readonly').objectStore(STORE).get(id)
  );
  return record?.blob;
}

/**
 * Deletes stored images that the plan no longer references. Only images older than
 * `minAgeMs` go, so a plan another tab just imported is left alone.
 */
export async function pruneUnderlays(keepIds: Set<string>, minAgeMs: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const cutoff = Date.now() - minAgeMs;
  const cursorReq = tx.objectStore(STORE).openCursor();
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) return;
    const record = cursor.value as StoredImage;
    if (!keepIds.has(record.id) && record.createdAt < cutoff) cursor.delete();
    cursor.continue();
  };
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- In-memory registry: image id -> URL the canvas can render ----
// URLs live for the whole session: undo can bring back an earlier underlay at any time.

const urls = new Map<string, string>();
const listeners = new Set<() => void>();
const loading = new Set<string>();

function registerUrl(id: string, url: string): void {
  if (urls.get(id) === url) return;
  urls.set(id, url);
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The URL to render for an underlay id, loading it from IndexedDB on first use. */
export function useUnderlayUrl(id: string | undefined): string | null {
  const url = useSyncExternalStore(subscribe, () => (id ? urls.get(id) ?? null : null));
  useEffect(() => {
    if (!id || urls.has(id) || loading.has(id)) return;
    loading.add(id);
    getImage(id)
      .then((blob) => {
        if (blob) registerUrl(id, URL.createObjectURL(blob));
        else console.warn(`Underlay image ${id} is missing from storage`);
      })
      .catch((err) => console.warn('Could not load underlay image:', err))
      .finally(() => loading.delete(id));
  }, [id]);
  return url;
}

// ---- Images not yet safely in IndexedDB ----
// Until an image's write is confirmed, saves keep embedding it as a data URL (the old
// format), so a reload or a closed tab can never lose it.

const inlineFallback = new Map<string, string>();

/** The data URL to embed in saves for this id, or undefined once it is stored. */
export function getInlineFallback(id: string): string | undefined {
  return inlineFallback.get(id);
}

export function hasPendingInlineImages(): boolean {
  return inlineFallback.size > 0;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Saved plans from before this change embed the image; it is moved over under a fixed id so
// that repeating the migration (StrictMode, or after a failed attempt) is harmless.
export const LEGACY_UNDERLAY_ID = 'legacy-underlay';

/** Registers a saved plan's embedded image for display, pending its move to IndexedDB. */
export function adoptLegacyUnderlay(dataUrl: string): string {
  registerUrl(LEGACY_UNDERLAY_ID, dataUrl);
  inlineFallback.set(LEGACY_UNDERLAY_ID, dataUrl);
  return LEGACY_UNDERLAY_ID;
}

/** Moves adopted legacy images into IndexedDB. Resolves true if anything was moved. */
export async function migrateLegacyUnderlays(): Promise<boolean> {
  let moved = false;
  for (const [id, dataUrl] of [...inlineFallback]) {
    if (id !== LEGACY_UNDERLAY_ID) continue;
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await putImage(id, blob);
      inlineFallback.delete(id);
      moved = true;
    } catch (err) {
      // Keep saving it embedded, as before.
      console.warn('Could not move the underlay image to IndexedDB:', err);
    }
  }
  return moved;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
    reader.readAsDataURL(blob);
  });
}

/** Stores a newly imported image and returns the id to put in the plan. */
export async function storeUnderlayImage(blob: Blob): Promise<string> {
  const id = newId();
  try {
    await putImage(id, blob);
  } catch (err) {
    console.warn('Could not store the underlay in IndexedDB; embedding it in the save:', err);
    inlineFallback.set(id, await blobToDataUrl(blob));
  }
  registerUrl(id, URL.createObjectURL(blob));
  return id;
}
