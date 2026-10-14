'use client';

import type { DocumentEdits, EditableDocument, JobError } from '@docuview/shared';
import { ApiError, fetchApi } from './api';

/**
 * Editing documents: what the server says can be edited, sending the changes
 * back, and putting the result on the user's disk.
 */

async function failure(response: Response, fallback: string): Promise<ApiError> {
  let info: JobError = { code: `http_${response.status}`, message: fallback, retryable: false };
  try {
    const body = (await response.json()) as { error?: JobError };
    if (body.error) info = body.error;
  } catch {
    /* not JSON */
  }
  return new ApiError(info, response.status);
}

export async function getEditable(fileId: string): Promise<EditableDocument> {
  const response = await fetchApi(`/api/v1/files/${fileId}/editable`);
  if (!response.ok) throw await failure(response, "We couldn't read this document for editing.");
  return (await response.json()) as EditableDocument;
}

export async function saveEdited(fileId: string, edits: DocumentEdits): Promise<Blob> {
  const response = await fetchApi(`/api/v1/files/${fileId}/edited`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(edits),
  });
  if (!response.ok) throw await failure(response, "We couldn't save these changes into the document.");
  return response.blob();
}

/** The original file's bytes (for formats edited in the browser: PDF, text). */
export async function originalBytes(fileId: string): Promise<ArrayBuffer> {
  const response = await fetchApi(`/api/v1/files/${fileId}/raw`);
  if (!response.ok) throw await failure(response, 'This document is no longer available.');
  return response.arrayBuffer();
}

type SaveWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> }>;
};

/** "Report.docx" → "Report (edited).docx". */
export function editedName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (edited)${name.slice(dot)}` : `${name} (edited)`;
}

/**
 * Put a file on disk. Edge and Chrome ask where, with the name filled in;
 * other browsers download it. Resolves false when the user cancelled.
 */
export async function saveToDisk(blob: Blob, name: string): Promise<boolean> {
  const picker = (window as SaveWindow).showSaveFilePicker;
  if (picker) {
    const extension = /\.[^.]+$/.exec(name)?.[0] ?? '';
    try {
      const handle = await picker({
        suggestedName: name,
        types: extension ? [{ description: extension.slice(1).toUpperCase(), accept: { [blob.type || 'application/octet-stream']: [extension] } }] : undefined,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return false;
      // Anything else (a policy, an odd type): fall back to a download.
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}
