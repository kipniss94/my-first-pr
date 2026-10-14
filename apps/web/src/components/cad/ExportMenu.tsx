'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ExportFormat } from '@/lib/cad/export';
import { useT } from '@/lib/prefs';

export type ExportScope = 'model' | 'selection';

/** Something the menu can save: a format written here, or the exact solid. */
export type ExportChoice = ExportFormat | 'parasolid';

interface ExportMenuProps {
  /** A part is selected, so it can be saved on its own. */
  hasSelection: boolean;
  /** The exact solid is on the server as a Parasolid .x_t. */
  hasParasolid: boolean;
  /** Resolves with a sentence worth telling, if any (a STEP that was simplified). */
  onExport(choice: ExportChoice, scope: ExportScope): Promise<string | void>;
}

const CHOICES: { id: ExportChoice; label: string; note: string }[] = [
  { id: 'step', label: 'STEP (.step)', note: 'For CAD: a solid of flat faces, from the mesh shown' },
  { id: 'stl', label: 'STL (.stl)', note: 'For 3D printing: every slicer reads it' },
  { id: '3mf', label: '3MF (.3mf)', note: 'For 3D printing: millimetres, colours, separate parts' },
  { id: 'obj', label: 'OBJ (.obj)', note: 'For 3D editors, with vertex colours' },
  { id: 'ply', label: 'PLY (.ply)', note: 'Mesh with colours, for scanning and analysis tools' },
  { id: 'glb', label: 'glTF (.glb)', note: 'For the web, AR and Blender' },
];

/**
 * "Save as" for the 3D model: STEP for other CAD systems, STL and 3MF for
 * printers, OBJ, PLY and glTF for everything else. Written in the browser from
 * the model on screen; hidden parts are left out.
 */
export function ExportMenu({ hasSelection, hasParasolid, onExport }: ExportMenuProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<ExportScope>('model');
  const [busy, setBusy] = useState<ExportChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [position, setPosition] = useState<{ bottom: number; right: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Placed against the viewport: the toolbar scrolls, and would clip it.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({ bottom: Math.round(window.innerHeight - rect.top + 8), right: Math.max(8, Math.round(window.innerWidth - rect.right - 120)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocumentClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocumentClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocumentClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!hasSelection) setScope('model');
  }, [hasSelection]);

  const run = async (choice: ExportChoice) => {
    setBusy(choice);
    setError(null);
    setNotice(null);
    try {
      // Let the "Preparing…" state paint before the work starts.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const said = await onExport(choice, scope);
      if (said) setNotice(said);
      else setOpen(false);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('The file could not be written.'));
    } finally {
      setBusy(null);
    }
  };

  const items: { id: ExportChoice; label: string; note: string }[] = hasParasolid
    ? [{ id: 'parasolid', label: 'Parasolid (.x_t)', note: 'The exact solid, as SOLIDWORKS keeps it: opens in SOLIDWORKS, NX, KOMPAS-3D, Fusion' }, ...CHOICES]
    : CHOICES;

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="btn btn-ghost"
        aria-expanded={open}
        aria-haspopup="menu"
        title={t('Save the model as STEP, STL, 3MF, OBJ, PLY or glTF')}
        data-testid="export-button"
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
          <path d="M8 2.5v7.5M5 7l3 3 3-3M3 12.5h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t('Export')}
      </button>
      {open && position && (
        <div
          role="menu"
          style={{ bottom: position.bottom, right: position.right }}
          className="fixed z-50 w-80 overflow-hidden rounded-lg border border-line bg-ink-800 shadow-2xl"
          data-testid="export-menu"
        >
          <div className="flex items-center gap-1 border-b border-line p-2">
            {(['model', 'selection'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setScope(value)}
                disabled={value === 'selection' && !hasSelection}
                aria-pressed={scope === value}
                className={`flex-1 rounded-md px-2 py-1 text-[12px] font-medium transition-colors disabled:opacity-40 ${
                  scope === value ? 'bg-ink-600 text-mist-100' : 'text-mist-400 hover:text-mist-200'
                }`}
                data-testid={`export-scope-${value}`}
              >
                {value === 'model' ? t('Whole model') : t('Selected part')}
              </button>
            ))}
          </div>
          <div className="py-1">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={busy !== null || (item.id === 'parasolid' && scope === 'selection')}
                onClick={() => run(item.id)}
                className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-ink-700 disabled:opacity-50"
                data-testid={`export-${item.id}`}
              >
                <span className="text-[13px] text-mist-100">
                  {item.label}
                  {busy === item.id && <span className="ml-2 text-[11px] text-accent-bright">{t('Preparing…')}</span>}
                </span>
                <span className="text-[11px] leading-snug text-mist-500">{t(item.note)}</span>
              </button>
            ))}
          </div>
          <p className="border-t border-line px-3 py-2 text-[11px] leading-snug text-mist-500">
            {error ? (
              <span className="text-danger">{error}</span>
            ) : notice ? (
              <span className="text-mist-200" data-testid="export-notice">
                {notice}
              </span>
            ) : (
              t('Millimetres. Hidden parts are left out.')
            )}
          </p>
        </div>
      )}
    </div>
  );
}
