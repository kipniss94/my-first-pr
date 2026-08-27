'use client';

import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

interface PdfPageProps {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  /** Search term to mark inside the text layer, or `null`. */
  highlight: string | null;
  fallbackSize: { width: number; height: number } | null;
}

/**
 * One page.
 *
 * Pages render only once they are near the viewport and drop their canvas when
 * they scroll far away, so a 500-page document keeps a bounded amount of pixel
 * data alive instead of trying to hold all of it.
 */
export function PdfPage({ document: pdf, pageNumber, scale, highlight, fallbackSize }: PdfPageProps) {
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
      <div ref={textLayerRef} className="pdf-text-layer" />
      {!rendered && (
        <div className="absolute inset-0 grid place-items-center bg-white">
          <span className="font-mono text-[11px] text-slate-400">{pageNumber}</span>
        </div>
      )}
    </div>
  );
}
