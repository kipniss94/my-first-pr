"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { originalBytes } from "@/lib/edit";
import { useT } from "@/lib/prefs";

interface DocxPagesProps {
  fileId: string;
  /** Called with the page count once the document is laid out. */
  onPages?(count: number): void;
  onError(): void;
}

const THUMBNAIL_WIDTH = 132;

/**
 * A Word document as its pages, with a rail of page thumbnails beside them —
 * the way the PDF viewer shows a PDF.
 *
 * docx-preview lays the original .docx out page by page: it breaks pages
 * where Word last broke them (Word saves that in the file) and where the
 * document asks for a break, with each section's paper size and margins,
 * headers and footers. Each thumbnail is a copy of its page, scaled down.
 */
export function DocxPages({ fileId, onPages, onError }: DocxPagesProps) {
  const { t } = useT();
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLUListElement>(null);
  const [pages, setPages] = useState<HTMLElement[]>([]);
  const [current, setCurrent] = useState(1);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [pageWidth, setPageWidth] = useState(816);
  const [areaWidth, setAreaWidth] = useState(0);
  const [loading, setLoading] = useState(true);

  // Lay the document out.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ renderAsync }, data] = await Promise.all([
          import("docx-preview"),
          originalBytes(fileId),
        ]);
        if (cancelled || !bodyRef.current || !styleRef.current) return;
        bodyRef.current.innerHTML = "";
        styleRef.current.innerHTML = "";
        await renderAsync(data, bodyRef.current, styleRef.current, {
          className: "docx",
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          experimental: true,
          trimXmlDeclaration: true,
          useBase64URL: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        });
        if (cancelled || !bodyRef.current) return;
        const found = [
          ...bodyRef.current.querySelectorAll<HTMLElement>("section.docx"),
        ];
        setPages(found);
        setPageWidth(found[0]?.offsetWidth || 816);
        onPages?.(found.length);
        setLoading(false);
      } catch {
        if (!cancelled) onError();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId, onError, onPages]);

  // The page in view.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || pages.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0])
          setCurrent(pages.indexOf(visible[0].target as HTMLElement) + 1);
      },
      { root, threshold: [0.25, 0.5, 0.75] },
    );
    pages.forEach((page) => observer.observe(page));
    return () => observer.disconnect();
  }, [pages]);

  // The width there is to fit pages into.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setAreaWidth(element.clientWidth),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    railRef.current
      ?.querySelector<HTMLElement>(`[data-thumb="${current}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const scale =
    zoom === "fit"
      ? Math.min(1.6, Math.max(0.3, (areaWidth - 48) / pageWidth))
      : zoom;

  const goTo = useCallback(
    (page: number) => {
      pages[page - 1]?.scrollIntoView({ block: "start", behavior: "smooth" });
      setCurrent(page);
    },
    [pages],
  );

  // Page Up / Page Down move a page at a time, as in the PDF viewer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "PageDown") {
        event.preventDefault();
        goTo(Math.min(pages.length, current + 1));
      } else if (event.key === "PageUp") {
        event.preventDefault();
        goTo(Math.max(1, current - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, goTo, pages.length]);

  const percent = Math.round(scale * 100);

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-40 shrink-0 flex-col border-r border-line bg-ink-850 sm:flex">
        <h2 className="border-b border-line px-3 py-2.5 field-label">
          {t("Pages")}
        </h2>
        <ul
          ref={railRef}
          className="min-h-0 flex-1 space-y-2 overflow-auto p-2"
          data-testid="docx-thumbnails"
        >
          {pages.map((page, index) => (
            <li key={index} data-thumb={index + 1}>
              <button
                type="button"
                onClick={() => goTo(index + 1)}
                className={`block w-full rounded-md border p-1 transition-colors ${
                  current === index + 1
                    ? "border-accent bg-accent-soft/50"
                    : "border-line hover:border-line-strong"
                }`}
                aria-current={current === index + 1 ? "page" : undefined}
              >
                <PageThumbnail page={page} />
                <span className="mt-1 block text-center font-mono text-[11px] text-mist-400">
                  {index + 1}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-ink-850 px-3 text-[12px] text-mist-300">
          <span className="font-mono" data-testid="docx-page-indicator">
            {pages.length > 0 ? `${current} / ${pages.length}` : "…"}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              className="btn-icon"
              onClick={() => setZoom(Math.max(0.3, scale - 0.1))}
              aria-label={t("Zoom out")}
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                <path
                  d="M4 8h8"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <span className="w-11 text-center font-mono">{percent}%</span>
            <button
              type="button"
              className="btn-icon"
              onClick={() => setZoom(Math.min(3, scale + 0.1))}
              aria-label={t("Zoom in")}
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                <path
                  d="M8 4v8M4 8h8"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setZoom("fit")}
              aria-pressed={zoom === "fit"}
            >
              {t("Fit width")}
            </button>
          </div>
        </div>
        <div
          ref={scrollRef}
          className="docx-pages min-h-0 flex-1 overflow-auto bg-[var(--sheet-surround)]"
        >
          {loading && (
            <div className="mx-auto mt-10 max-w-[42rem] space-y-3 px-6">
              {[...Array(6)].map((_, index) => (
                <div
                  key={index}
                  className="skeleton h-4 rounded"
                  style={{ width: `${70 + ((index * 13) % 30)}%` }}
                />
              ))}
            </div>
          )}
          <div ref={styleRef} />
          <div style={{ zoom: scale }} data-testid="docx-pages">
            <div ref={bodyRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** A page, scaled down: a copy of it, so the page itself stays where it is. */
function PageThumbnail({ page }: { page: HTMLElement }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const width = page.offsetWidth || 816;
  const height = page.offsetHeight || 1056;
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
    const copy = page.cloneNode(true) as HTMLElement;
    copy.style.transform = `scale(${scale})`;
    copy.style.transformOrigin = "top left";
    copy.style.margin = "0";
    copy.style.boxShadow = "none";
    copy.style.pointerEvents = "none";
    copy.removeAttribute("id");
    host.replaceChildren(copy);
  }, [page, scale, visible]);

  return (
    <div
      ref={hostRef}
      className="docx-thumb w-full overflow-hidden rounded-sm bg-white"
      style={{ height: Math.round(height * scale) }}
      aria-hidden="true"
    />
  );
}
