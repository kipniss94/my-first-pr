'use client';

import { useEffect, useRef, useState } from 'react';
import type { SlideData, SlideDocument, SlideShape } from '@docuview/shared';
import { apiUrl } from '@/lib/api';

interface NativeSlidesProps {
  document: SlideDocument;
  currentSlide: number;
  onSlideChange(slide: number): void;
  notesOpen: boolean;
  onNotesToggle(): void;
}

/**
 * The fallback slide renderer, used when the server has no LibreOffice.
 *
 * Shapes are absolutely positioned in the presentation's own coordinate space
 * and the whole slide is scaled to fit, so text keeps its relative placement
 * without needing a layout engine.
 */
export function NativeSlides({ document, currentSlide, onSlideChange, notesOpen, onNotesToggle }: NativeSlidesProps) {
  const slide = document.slides.find((entry) => entry.index === currentSlide) ?? document.slides[0];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        onSlideChange(Math.min(document.slides.length, currentSlide + 1));
      }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        onSlideChange(Math.max(1, currentSlide - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentSlide, document.slides.length, onSlideChange]);

  if (!slide) {
    return <div className="grid min-h-0 flex-1 place-items-center text-sm text-mist-400">No slides to show.</div>;
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-ink-850 px-3">
        <button
          type="button"
          className="btn-icon"
          onClick={() => onSlideChange(Math.max(1, currentSlide - 1))}
          disabled={currentSlide <= 1}
          aria-label="Previous slide"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
            <path d="M10 3.5 6 8l4 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="font-mono text-[12px] text-mist-300">
          {currentSlide} / {document.slides.length}
        </span>
        <button
          type="button"
          className="btn-icon"
          onClick={() => onSlideChange(Math.min(document.slides.length, currentSlide + 1))}
          disabled={currentSlide >= document.slides.length}
          aria-label="Next slide"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
            <path d="M6 3.5 10 8l-4 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onNotesToggle}
          data-active={notesOpen ? 'true' : undefined}
          className="btn btn-ghost ml-auto"
        >
          Notes
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-ink-950/60 p-6">
        <ScaledSlide slide={slide} width={document.width} height={document.height} />
      </div>

      {notesOpen && (
        <div className="max-h-40 shrink-0 overflow-auto border-t border-line bg-ink-850 px-4 py-3">
          <h2 className="field-label">Speaker notes · slide {currentSlide}</h2>
          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-mist-300">
            {slide.notes ?? 'No notes on this slide.'}
          </p>
        </div>
      )}
    </div>
  );
}

function ScaledSlide({ slide, width, height }: { slide: SlideData; width: number; height: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const available = element.clientWidth;
      setScale(Math.min(1.6, Math.max(0.15, available / width)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [width]);

  return (
    <div ref={containerRef} className="mx-auto max-w-5xl">
      <div
        className="relative mx-auto overflow-hidden bg-white shadow-[0_4px_28px_-8px_rgba(0,0,0,0.6)]"
        style={{ width: width * scale, height: height * scale }}
        data-testid="native-slide"
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ width, height, transform: `scale(${scale})` }}
        >
          {slide.shapes.map((shape, index) => (
            <Shape key={index} shape={shape} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Shape({ shape }: { shape: SlideShape }) {
  const style: React.CSSProperties = {
    position: 'absolute',
    left: shape.x,
    top: shape.y,
    width: shape.w,
    height: shape.h,
    transform: shape.rot ? `rotate(${shape.rot}deg)` : undefined,
  };

  if (shape.type === 'image' && shape.src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={apiUrl(shape.src)} alt="" style={{ ...style, objectFit: 'contain' }} />
    );
  }

  if (shape.type === 'rect') {
    return <div style={{ ...style, backgroundColor: shape.fill ?? 'transparent' }} />;
  }

  return (
    <div style={{ ...style, backgroundColor: shape.fill ?? 'transparent', overflow: 'hidden' }}>
      {(shape.paragraphs ?? []).map((paragraph, index) => (
        <p
          key={index}
          style={{
            textAlign: paragraph.align,
            marginLeft: paragraph.level * 24,
            marginBottom: 6,
            listStyle: paragraph.bullet ? 'disc' : undefined,
            color: '#111827',
          }}
        >
          {paragraph.bullet && <span style={{ marginRight: 8 }}>•</span>}
          {paragraph.runs.map((run, runIndex) => (
            <span
              key={runIndex}
              style={{
                fontWeight: run.bold ? 700 : 400,
                fontStyle: run.italic ? 'italic' : undefined,
                textDecoration: run.underline ? 'underline' : undefined,
                fontSize: run.size ? `${run.size}px` : '18px',
                color: run.color ?? undefined,
                fontFamily: run.font ? `${run.font}, sans-serif` : undefined,
              }}
            >
              {run.text}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}
