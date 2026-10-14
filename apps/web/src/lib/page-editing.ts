'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiUrl, deletePages as requestDelete, getPageState, undoPageEdit } from './api';
import { replaceDocumentBlob } from './cache';

/**
 * Page editing for one open document: delete pages, undo.
 *
 * The server edits the stored file itself, so the result is a real edited
 * .pdf or .docx. `revision` changes with every edit; anything that loads the
 * file — the page view, the download link — includes it, so no browser or
 * proxy can hand back the version from before the edit.
 */
export interface PageEditing {
  editable: boolean;
  revision: number;
  busy: boolean;
  canUndo: boolean;
  message: { tone: 'info' | 'error'; text: string } | null;
  deletePages(pages: number[]): Promise<boolean>;
  undo(): Promise<boolean>;
  dismiss(): void;
}

function describe(pages: number[]): string {
  const sorted = [...pages].sort((a, b) => a - b);
  return sorted.length === 1 ? `Page ${sorted[0]} deleted.` : `Pages ${sorted.join(', ')} deleted.`;
}

export function usePageEditing(fileId: string | null, docId: string | null, fileName: string): PageEditing {
  const [editable, setEditable] = useState(false);
  const [revision, setRevision] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<PageEditing['message']>(null);

  useEffect(() => {
    if (!fileId) return;
    let cancelled = false;
    getPageState(fileId)
      .then((state) => {
        if (cancelled) return;
        setEditable(state.editable);
        setRevision(state.revision);
        setCanUndo(state.canUndo);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  /** Keep the workspace's copy in step, so reopening the card shows the edit. */
  const refreshCache = useCallback(
    async (nextRevision: number) => {
      if (!fileId || !docId) return;
      try {
        const response = await fetch(apiUrl(`/api/v1/files/${fileId}/raw?v=${nextRevision}`));
        if (response.ok) await replaceDocumentBlob(docId, new File([await response.blob()], fileName));
      } catch {
        /* the server copy is the edited one; the cache catches up next time */
      }
    },
    [docId, fileId, fileName],
  );

  const run = useCallback(
    async (action: () => ReturnType<typeof undoPageEdit>, success: (pageCount: number) => string) => {
      if (!fileId || busy) return false;
      setBusy(true);
      setMessage(null);
      try {
        const outcome = await action();
        setRevision(outcome.revision);
        setCanUndo(outcome.canUndo);
        setMessage({ tone: 'info', text: [success(outcome.pageCount), outcome.note].filter(Boolean).join(' ') });
        void refreshCache(outcome.revision);
        return true;
      } catch (err) {
        setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : "The pages couldn't be changed." });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, fileId, refreshCache],
  );

  const deletePages = useCallback(
    (pages: number[]) =>
      run(
        () => requestDelete(fileId as string, pages),
        (count) => `${describe(pages)} ${count} page${count === 1 ? '' : 's'} left.`,
      ),
    [fileId, run],
  );

  const undo = useCallback(() => run(() => undoPageEdit(fileId as string), () => 'Last change undone.'), [fileId, run]);
  const dismiss = useCallback(() => setMessage(null), []);

  return useMemo(
    () => ({ editable, revision, busy, canUndo, message, deletePages, undo, dismiss }),
    [busy, canUndo, deletePages, dismiss, editable, message, revision, undo],
  );
}

/** Append the revision to a URL, so an edited file is never served from cache. */
export function withRevision(url: string, revision: number): string {
  if (!revision) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${revision}`;
}
