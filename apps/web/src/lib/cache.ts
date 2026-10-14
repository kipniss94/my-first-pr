'use client';

import { useEffect, useState } from 'react';
import type { DocumentKind, ViewerId } from '@docuview/shared';

/**
 * The workspace's local cache.
 *
 * Every document that is opened is kept in the browser — its bytes, a
 * thumbnail, and enough metadata to reopen it — so the desktop can show what
 * you have been working on and open any of it again instantly. Nothing here
 * leaves the device: this is IndexedDB on the visitor's own machine, and
 * clearing it is one button.
 */

const DATABASE = 'docuview';
const VERSION = 1;
const DOCUMENTS = 'documents';
const BLOBS = 'blobs';

/** Ceilings for the cache. Oldest documents are evicted first. */
const MAX_DOCUMENTS = 60;
const MAX_BYTES = 600 * 1024 * 1024;

export interface CachedDocument {
  id: string;
  name: string;
  size: number;
  extension: string;
  kind: DocumentKind | 'unknown';
  formatId: string | null;
  formatLabel: string | null;
  viewer: ViewerId | null;
  /** Server job, reused for an instant reopen while it is still alive. */
  jobId: string | null;
  fileId: string | null;
  createdAt: number;
  openedAt: number;
  thumbnail: Blob | null;
  /** False when the file was too large to keep, or storage refused it. */
  hasBlob: boolean;
}

/* ------------------------------- plumbing --------------------------------- */

let databasePromise: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve) => {
    // Private browsing, a blocked origin or an ancient browser: the workspace
    // still works, it just cannot remember anything.
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE, VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DOCUMENTS)) {
        db.createObjectStore(DOCUMENTS, { keyPath: 'id' }).createIndex('openedAt', 'openedAt');
      }
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return databasePromise;
}

function run<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => IDBRequest<T> | null,
): Promise<T | null> {
  return openDatabase().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        let request: IDBRequest<T> | null;
        try {
          const tx = db.transaction(storeNames, mode);
          request = body(tx);
          tx.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
          return;
        }
        if (!request) {
          resolve(null);
          return;
        }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      }),
  );
}

/* ------------------------------ notifications ------------------------------ */

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeToCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* -------------------------------- reading ---------------------------------- */

export async function listDocuments(): Promise<CachedDocument[]> {
  const all = await run<CachedDocument[]>(DOCUMENTS, 'readonly', (tx) => tx.objectStore(DOCUMENTS).getAll());
  if (!all) return [];
  return all.sort((a, b) => b.openedAt - a.openedAt);
}

export function getDocument(id: string): Promise<CachedDocument | null> {
  return run<CachedDocument>(DOCUMENTS, 'readonly', (tx) => tx.objectStore(DOCUMENTS).get(id));
}

export async function getDocumentBlob(id: string): Promise<Blob | null> {
  const record = await run<{ id: string; blob: Blob }>(BLOBS, 'readonly', (tx) => tx.objectStore(BLOBS).get(id));
  return record?.blob ?? null;
}

/** Reconstruct the original file so it can be sent again. */
export async function getDocumentFile(document: CachedDocument): Promise<File | null> {
  const blob = await getDocumentBlob(document.id);
  if (!blob) return null;
  return new File([blob], document.name, { type: blob.type || 'application/octet-stream' });
}

/* -------------------------------- writing ---------------------------------- */

export function newDocumentId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `d-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Remember a file the moment it is picked, before anything else happens. */
export async function rememberDocument(id: string, file: File): Promise<void> {
  const now = Date.now();
  const document: CachedDocument = {
    id,
    name: file.name,
    size: file.size,
    extension: /\.([A-Za-z0-9_]{1,12})$/.exec(file.name)?.[1].toLowerCase() ?? '',
    kind: 'unknown',
    formatId: null,
    formatLabel: null,
    viewer: null,
    jobId: null,
    fileId: null,
    createdAt: now,
    openedAt: now,
    thumbnail: null,
    hasBlob: false,
  };

  await run(DOCUMENTS, 'readwrite', (tx) => tx.objectStore(DOCUMENTS).put(document));
  emit();

  // The bytes go in separately: a quota rejection there must not cost us the
  // card itself, which is still useful without them.
  const stored = await run(BLOBS, 'readwrite', (tx) => tx.objectStore(BLOBS).put({ id, blob: file }));
  if (stored !== null) {
    await patchDocument(id, { hasBlob: true });
  }
  void evict();
}

export async function patchDocument(id: string, patch: Partial<CachedDocument>): Promise<void> {
  const current = await getDocument(id);
  if (!current) return;
  await run(DOCUMENTS, 'readwrite', (tx) => tx.objectStore(DOCUMENTS).put({ ...current, ...patch }));
  emit();
}

export function touchDocument(id: string): Promise<void> {
  return patchDocument(id, { openedAt: Date.now() });
}

/**
 * Store the picture shown on the card.
 *
 * Thumbnails are produced by the viewer that opened the document — the 3D
 * scene's own framebuffer, the first PDF page, the image itself — so the card
 * shows the real document rather than a generic file icon.
 */
export async function setThumbnail(id: string, source: string): Promise<void> {
  try {
    // Either a `data:` URL from a canvas or a same-origin asset URL; both turn
    // into a blob the same way.
    const response = await fetch(source);
    const blob = await response.blob();
    await patchDocument(id, { thumbnail: blob });
  } catch {
    /* A thumbnail is a nicety; failing to make one changes nothing else. */
  }
}

export async function removeDocument(id: string): Promise<void> {
  await run(DOCUMENTS, 'readwrite', (tx) => tx.objectStore(DOCUMENTS).delete(id));
  await run(BLOBS, 'readwrite', (tx) => tx.objectStore(BLOBS).delete(id));
  emit();
}

export async function clearDocuments(): Promise<void> {
  await run(DOCUMENTS, 'readwrite', (tx) => tx.objectStore(DOCUMENTS).clear());
  await run(BLOBS, 'readwrite', (tx) => tx.objectStore(BLOBS).clear());
  emit();
}

/** Drop the oldest documents once the cache is over either ceiling. */
async function evict(): Promise<void> {
  const all = await listDocuments();
  let bytes = all.reduce((total, document) => total + document.size, 0);
  const doomed: string[] = [];

  for (let index = all.length - 1; index >= 0; index -= 1) {
    if (all.length - doomed.length <= MAX_DOCUMENTS && bytes <= MAX_BYTES) break;
    doomed.push(all[index].id);
    bytes -= all[index].size;
  }
  for (const id of doomed) await removeDocument(id);
}

/* --------------------------------- React ----------------------------------- */

/** The desktop's document list, kept in step with the cache. */
export function useCachedDocuments(): { documents: CachedDocument[]; loading: boolean } {
  const [documents, setDocuments] = useState<CachedDocument[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void listDocuments().then((all) => {
        if (cancelled) return;
        setDocuments(all);
        setLoading(false);
      });
    };
    refresh();
    const unsubscribe = subscribeToCache(refresh);
    // Another tab may have opened or removed something.
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return { documents, loading };
}
