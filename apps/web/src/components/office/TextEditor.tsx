'use client';

import { useEffect, useState } from 'react';
import { editedName, originalBytes, saveToDisk } from '@/lib/edit';
import { useT } from '@/lib/prefs';
import { EditorBar } from './DocEditor';

/** A text file is decoded as UTF-8 when it is valid UTF-8, else as Windows Cyrillic. */
function decode(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

/**
 * Editing a plain text or CSV file: the whole text in one field, saved back as
 * UTF-8 under the same kind of name.
 */
export function TextEditor({ fileId, fileName, onClose }: { fileId: string; fileName: string; onClose(): void }) {
  const { t } = useT();
  const [original, setOriginal] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    originalBytes(fileId).then(
      (bytes) => {
        if (cancelled) return;
        const value = decode(bytes);
        setOriginal(value);
        setText(value);
      },
      (err: Error) => !cancelled && setFailed(t(err.message)),
    );
    return () => {
      cancelled = true;
    };
  }, [fileId, t]);

  const dirty = original !== null && text !== original;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="text-editor">
      <EditorBar
        title={t('Editing')}
        fileName={fileName}
        info={t('Saved as UTF-8 text.')}
        changes={dirty ? 1 : 0}
        saving={saving}
        saveLabel={t('Save…')}
        notice={notice}
        onClose={() => {
          if (dirty && !window.confirm(t('Leave without saving? The changes will be lost.'))) return;
          onClose();
        }}
        onSave={() => {
          setSaving(true);
          // A byte-order mark tells Excel and Notepad that a CSV is UTF-8.
          const bom = /\.csv$/i.test(fileName) ? '﻿' : '';
          void saveToDisk(new Blob([bom + text], { type: 'text/plain;charset=utf-8' }), editedName(fileName))
            .then((done) => done && setNotice(t('Saved. The original on the server is unchanged.')))
            .finally(() => setSaving(false));
        }}
      />
      <div className="min-h-0 flex-1 bg-paper-2 p-4">
        {failed ? (
          <p className="text-center text-sm text-danger">{failed}</p>
        ) : (
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none rounded-xl border border-paper-line bg-paper p-4 font-mono text-[13px] leading-relaxed text-paper-ink outline-none focus:border-accent"
            data-testid="text-editor-field"
          />
        )}
      </div>
    </div>
  );
}
