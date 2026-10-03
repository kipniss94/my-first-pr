'use client';

import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { PdfTextEdit } from '@/lib/pdf-edit';
import { useT } from '@/lib/prefs';

interface PdfPageProps {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  /** Search term to mark inside the text layer, or `null`. */
  highlight: string | null;
  fallbackSize: { width: number; height: number } | null;
  /** Editing: the page's text runs become clickable fields. */
  editing?: boolean;
  /** Marked for deletion while editing. */
  deleted?: boolean;
  /** This page's changed runs, by their index in the page's text. */
  edits?: Map<number, PdfTextEdit>;
  onEditText?(index: number, edit: PdfTextEdit | null): void;
}

interface TextRun {
  index: number;
  str: string;
  transform: number[];
  width: number;
}

/** PDF.js's matrix product: `m2` seen through `m1`. */
function multiply(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * One page.
 *
 * Pages render only once they are near the viewport and drop their canvas when
 * they scroll far away, so a 500-page document keeps a bounded amount of pixel
 * data alive instead of trying to hold all of it.
 */
export function PdfPage({
  document: pdf,
  pageNumber,
  scale,
  highlight,
  fallbackSize,
  editing = false,
  deleted = false,
  edits,
  onEditText,
}: PdfPageProps) {
  const { t } = useT();
  const [runs, setRuns] = useState<TextRun[] | null>(null);
  const [viewportTransform, setViewportTransform] = useState<number[] | null>(null);
  const [typing, setTyping] = useState<{ index: number; value: string } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState(() =>
    fallbackSize ? { width: fallbackSize.width * scale, height: fallbackSize.height * scale } : { width: 612, height: 792 },
  );
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.isIntersecting);
      },
      // A generous margin means pages are ready before they scroll into view.
      { root: element.closest('[data-testid="pdf-scroll"]'), rootMargin: '600px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (fallbackSize) setSize({ width: fallbackSize.width * scale, height: fallbackSize.height * scale });
  }, [fallbackSize, scale]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;

      const viewport = page.getViewport({ scale });
      setSize({ width: viewport.width, height: viewport.height });
      setViewportTransform(viewport.transform);

      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return;

      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      renderTaskRef.current?.cancel();
      const task = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      renderTaskRef.current = task;

      try {
        await task.promise;
      } catch (err) {
        // Cancellation is normal while scrolling fast.
        if (!(err instanceof Error) || !/cancel/i.test(err.message)) throw err;
        return;
      }
      if (cancelled) return;
      setRendered(true);

      // Text layer: makes the page selectable and gives search something to mark.
      const textContainer = textLayerRef.current;
      if (textContainer) {
        textContainer.textContent = '';
        textContainer.style.width = `${viewport.width}px`;
        textContainer.style.height = `${viewport.height}px`;
        try {
          const { TextLayer } = await import('pdfjs-dist');
          const layer = new TextLayer({
            textContentSource: page.streamTextContent(),
            container: textContainer,
            viewport,
          });
          await layer.render();
        } catch {
          /* selection is a bonus; the rendered page still works without it */
        }
      }
    })().catch(() => {
      /* a failed page must not take down the whole document */
    });

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [pdf, pageNumber, scale, visible]);

  // While editing, the page's text runs with where they sit.
  useEffect(() => {
    if (!editing || !visible || runs) return;
    let cancelled = false;
    pdf
      .getPage(pageNumber)
      .then((page) => page.getTextContent())
      .then((content) => {
        if (cancelled) return;
        const found: TextRun[] = [];
        content.items.forEach((item, index) => {
          if ('str' in item && item.str.trim().length > 0) found.push({ index, str: item.str, transform: item.transform, width: item.width });
        });
        setRuns(found);
      })
      .catch(() => setRuns([]));
    return () => {
      cancelled = true;
    };
  }, [editing, pageNumber, pdf, runs, visible]);

  // Mark search hits inside the rendered text layer.
  useEffect(() => {
    const container = textLayerRef.current;
    if (!container || !rendered) return;

    for (const mark of container.querySelectorAll('mark')) {
      mark.replaceWith(...Array.from(mark.childNodes));
    }
    container.normalize();
    if (!highlight || highlight.length < 2) return;

    const needle = highlight.toLowerCase();
    const walker = window.document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (node.textContent && node.textContent.toLowerCase().includes(needle)) targets.push(node);
    }
    for (const node of targets) {
      const text = node.textContent ?? '';
      const fragment = window.document.createDocumentFragment();
      let from = 0;
      for (;;) {
        const at = text.toLowerCase().indexOf(needle, from);
        if (at === -1) break;
        fragment.append(text.slice(from, at));
        const mark = window.document.createElement('mark');
        mark.textContent = text.slice(at, at + needle.length);
        fragment.append(mark);
        from = at + needle.length;
      }
      fragment.append(text.slice(from));
      node.replaceWith(fragment);
    }
  }, [highlight, rendered, scale]);

  return (
    <div
      ref={wrapperRef}
      data-page={pageNumber}
      className="relative bg-white shadow-[0_2px_18px_-4px_rgba(0,0,0,0.6)]"
      style={{ width: size.width, height: size.height }}
    >
      <canvas ref={canvasRef} className="block" />
      <div ref={textLayerRef} className="pdf-text-layer" style={editing ? { visibility: 'hidden' } : undefined} />
      {editing && runs && viewportTransform && !deleted && (
        <div className="absolute inset-0 z-[3]" data-testid="pdf-edit-layer">
          {runs.map((run) => {
            const [a, b, c, d, e, f] = multiply(viewportTransform, run.transform);
            const height = Math.hypot(c, d) || 10;
            const angle = Math.atan2(b, a);
            const width = Math.max(run.width * scale, height * 0.5);
            const edit = edits?.get(run.index);
            const active = typing?.index === run.index;
            const box: React.CSSProperties = {
              left: e,
              top: f - height,
              width,
              height: height * 1.2,
              transform: angle ? `rotate(${angle}rad)` : undefined,
              transformOrigin: `0 ${height}px`,
              fontSize: height * 0.86,
              lineHeight: `${height * 1.15}px`,
            };
            const commit = () => {
              if (!typing) return;
              const value = typing.value;
              setTyping(null);
              onEditText?.(
                run.index,
                value === run.str ? null : { page: pageNumber, transform: run.transform, width: run.width, original: run.str, text: value },
              );
            };
            if (active) {
              return (
                <input
                  key={run.index}
                  autoFocus
                  value={typing.value}
                  onChange={(event) => setTyping({ index: run.index, value: event.target.value })}
                  onBlur={commit}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commit();
                    if (event.key === 'Escape') setTyping(null);
                  }}
                  className="absolute min-w-[3rem] border border-accent bg-white px-0.5 font-sans text-black outline-none"
                  style={{ ...box, width: Math.max(width, typing.value.length * height * 0.55) }}
                  data-testid="pdf-edit-input"
                />
              );
            }
            return (
              <button
                key={run.index}
                type="button"
                title={t('Click to change this text')}
                onClick={() => setTyping({ index: run.index, value: edit?.text ?? run.str })}
                className={`absolute overflow-visible whitespace-pre text-left font-sans ${
                  edit ? 'bg-white text-black ring-1 ring-amber-400' : 'text-transparent hover:bg-accent/10 hover:ring-1 hover:ring-accent/60'
                }`}
                style={box}
                data-testid="pdf-edit-run"
              >
                {edit ? edit.text : run.str}
              </button>
            );
          })}
        </div>
      )}
      {deleted && (
        <div className="absolute inset-0 z-[4] grid place-items-center bg-red-500/25">
          <span className="rounded-md bg-red-600 px-3 py-1 text-[13px] font-medium text-white">{t('This page will be deleted')}</span>
        </div>
      )}
      {!rendered && (
        <div className="absolute inset-0 grid place-items-center bg-white">
          <span className="font-mono text-[11px] text-slate-400">{pageNumber}</span>
        </div>
      )}
    </div>
  );
}
