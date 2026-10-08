'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { originalBytes } from '@/lib/edit';
import { useT } from '@/lib/prefs';

interface OutlineEntry {
  index: number;
  title: string | null;
  notes: string | null;
}

interface PptxSlidesProps {
  fileId: string;
  outline: OutlineEntry[];
  onEdit: (() => void) | null;
  editable: boolean;
  onReady(): void;
  onError(): void;
}

/** Slides are laid out this wide, then shown at whatever size fits. */
const RENDER_WIDTH = 1280;
const THUMBNAIL_WIDTH = 168;

/**
 * A PowerPoint deck drawn in the browser from the file itself — masters,
 * layouts, backgrounds, shapes, pictures, tables and charts — by
 * pptx-preview, with no LibreOffice on the server. Slides follow one another
 * like a PDF's pages, a rail of thumbnails beside them.
 */
export function PptxSlides({ fileId, outline, onEdit, editable, onReady, onError }: PptxSlidesProps) {
  const { t } = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLOListElement>(null);
  const [slides, setSlides] = useState<HTMLElement[]>([]);
  const [current, setCurrent] = useState(1);
  const [areaWidth, setAreaWidth] = useState(0);
  const [notesOpen, setNotesOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ init }, data] = await Promise.all([import('pptx-preview'), originalBytes(fileId)]);
        const host = hostRef.current;
        if (cancelled || !host) return;
        host.innerHTML = '';
        const previewer = init(host, { width: RENDER_WIDTH, mode: 'list' });
        const deck = await previewer.load(data);
        if (cancelled) return;
        for (let index = 0; index < deck.slides.length; index += 1) {
          try {
            previewer.htmlRender.renderSlide(index);
          } catch {
            // One slide that does not draw leaves the rest.
          }
        }
        const found = [...host.querySelectorAll<HTMLElement>('.pptx-preview-slide-wrapper')];
        // Pictures the browser cannot show (EMF, WMF, TIFF) leave no broken icon.
        for (const image of host.querySelectorAll('img')) {
          image.decode().catch(() => image.setAttribute('data-broken', ''));
        }
        setSlides(found);
        setLoading(false);
        onReady();
      } catch {
        if (!cancelled) onError();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId, onError, onReady]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setAreaWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || slides.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setCurrent(slides.indexOf(visible[0].target as HTMLElement) + 1);
      },
      { root, threshold: [0.3, 0.6, 0.9] },
    );
    slides.forEach((slide) => observer.observe(slide));
    return () => observer.disconnect();
  }, [slides]);

  useEffect(() => {
    railRef.current?.querySelector<HTMLElement>(`[data-thumb="${current}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const goTo = useCallback(
    (slide: number) => {
      slides[slide - 1]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setCurrent(slide);
    },
    [slides],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === 'ArrowDown') {
        event.preventDefault();
        goTo(Math.min(slides.length, current + 1));
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp' || event.key === 'ArrowUp') {
        event.preventDefault();
        goTo(Math.max(1, current - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, goTo, slides.length]);

  const scale = Math.min(1.5, Math.max(0.2, (areaWidth - 48) / RENDER_WIDTH));
  const notes = outline.find((entry) => entry.index === current)?.notes ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-52 shrink-0 flex-col border-r border-line bg-ink-850 md:flex">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 className="field-label">{t('Slides')}</h2>
          {onEdit && (
            <button
              type="button"
              className="btn btn-primary !px-2 !py-1 text-[12px]"
              onClick={onEdit}
              disabled={!editable}
              title={editable ? t('Edit the text and delete slides, then save to your computer') : t('Editing works on .docx, .xlsx and .pptx; save older formats in those first.')}
              data-testid="edit-document"
            >
              {t('Edit')}
            </button>
          )}
        </div>
        <ol ref={railRef} className="min-h-0 flex-1 space-y-2 overflow-auto p-2" data-testid="slide-rail">
          {slides.map((slide, index) => (
            <li key={index} data-thumb={index + 1}>
              <button
                type="button"
                onClick={() => goTo(index + 1)}
                className={`block w-full rounded-md border p-1 transition-colors ${
                  current === index + 1 ? 'border-accent bg-accent-soft/50' : 'border-line hover:border-line-strong'
                }`}
                aria-current={current === index + 1 ? 'true' : undefined}
                title={outline.find((entry) => entry.index === index + 1)?.title ?? undefined}
              >
                <SlideThumbnail slide={slide} />
                <span className="mt-1 block text-center font-mono text-[11px] text-mist-400">{index + 1}</span>
              </button>
            </li>
          ))}
        </ol>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-ink-850 px-3 text-[12px] text-mist-300">
          <button type="button" className="btn-icon" onClick={() => goTo(Math.max(1, current - 1))} disabled={current <= 1} aria-label={t('Previous slide')}>
            <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
              <path d="M10 3.5 6 8l4 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <span className="font-mono" data-testid="slide-indicator">
            {slides.length > 0 ? `${current} / ${slides.length}` : '…'}
          </span>
          <button
            type="button"
            className="btn-icon"
            onClick={() => goTo(Math.min(slides.length, current + 1))}
            disabled={current >= slides.length}
            aria-label={t('Next slide')}
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
              <path d="M6 3.5 10 8l-4 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {outline.some((entry) => entry.notes) && (
            <button
              type="button"
              onClick={() => setNotesOpen((open) => !open)}
              data-active={notesOpen ? 'true' : undefined}
              className="btn btn-ghost ml-auto"
              data-testid="slides-notes-toggle"
            >
              {t('Notes')}
            </button>
          )}
        </div>
        <div ref={scrollRef} className="pptx-slides min-h-0 flex-1 overflow-auto bg-[var(--sheet-surround)] py-6">
          {loading && <div className="grid h-full place-items-center text-sm text-mist-400">{t('Loading slides…')}</div>}
          <div style={{ zoom: scale }}>
            <div ref={hostRef} className="pptx-host" data-testid="pptx-slides" />
          </div>
        </div>
        {notesOpen && (
          <div className="max-h-40 shrink-0 overflow-auto border-t border-line bg-ink-850 px-4 py-3">
            <h2 className="field-label">{t('Speaker notes · slide {n}', { n: current })}</h2>
            <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-mist-300">{notes ?? t('No notes on this slide.')}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** A slide, scaled down: a copy of it, drawn once it scrolls into the rail. */
function SlideThumbnail({ slide }: { slide: HTMLElement }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const width = slide.offsetWidth || RENDER_WIDTH;
  const height = slide.offsetHeight || RENDER_WIDTH * 0.5625;
  const scale = THUMBNAIL_WIDTH / width;

  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!visible || !host) return;
    const copy = slide.cloneNode(true) as HTMLElement;
    copy.style.transform = `scale(${scale})`;
    copy.style.transformOrigin = 'top left';
    copy.style.margin = '0';
    copy.style.pointerEvents = 'none';
    host.replaceChildren(copy);
  }, [scale, slide, visible]);

  return (
    <div
      ref={hostRef}
      className="pptx-thumb w-full overflow-hidden rounded-sm bg-white"
      style={{ aspectRatio: `${width} / ${height}` }}
      aria-hidden="true"
    />
  );
}
