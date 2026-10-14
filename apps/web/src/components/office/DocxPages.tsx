"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { docxWithoutPages } from "@/lib/docx-pages";
import { editedName, originalBytes, saveToDisk } from "@/lib/edit";
import { useT } from "@/lib/prefs";
import { EditorBar } from "./DocEditor";

interface DocxPagesProps {
  fileId: string;
  /** For the name of the saved copy. */
  fileName: string;
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
 *
 * Pages can be deleted the way PDF pages are: × on a thumbnail, the Delete
 * key or the toolbar button marks a page, and saving writes a copy of the
 * .docx without the marked pages. "Page 2" means the page 2 shown here —
 * the engine in @docuview/shared reproduces exactly how docx-preview splits
 * the document — and it takes the page's section with it, which is what
 * makes a deleted page actually go away.
 */
export function DocxPages({ fileId, fileName, onPages, onError }: DocxPagesProps) {
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
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
        // A page wider than the screen (landscape on a phone) stays reachable
        // by scrolling instead of being cut off on the left.
        bodyRef.current
          .querySelector<HTMLElement>(".docx-wrapper")
          ?.style.setProperty("align-items", "safe center");
        setPages(found);
        // "Fit width" fits the widest page, so landscape pages fit too.
        setPageWidth(Math.max(0, ...found.map((page) => page.offsetWidth)) || 816);
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

  const toggleMark = useCallback(
    (page: number) => {
      setNotice(null);
      setMarked((currentMarks) => {
        const next = new Set(currentMarks);
        if (next.has(page)) next.delete(page);
        else if (next.size + 1 >= pages.length) {
          setNotice(t("A document has to keep at least one page."));
          return currentMarks;
        } else next.add(page);
        return next;
      });
    },
    [pages.length, t],
  );

  // A marked page fades in the view too, so it is clear what will go.
  useEffect(() => {
    pages.forEach((page, index) => {
      const gone = marked.has(index + 1);
      page.style.opacity = gone ? "0.35" : "";
      page.style.outline = gone ? "3px solid rgb(220 38 38)" : "";
      page.title = gone ? t("Marked for deletion") : "";
    });
  }, [marked, pages, t]);

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const { blob } = await docxWithoutPages(await originalBytes(fileId), [...marked]);
      if (await saveToDisk(blob, editedName(fileName))) {
        setNotice(t("Saved without those pages. The original on the server is unchanged."));
      }
    } catch (err) {
      setNotice(t(err instanceof Error ? err.message : "We couldn't save these changes into the document."));
    } finally {
      setSaving(false);
    }
  };

  // Page Up / Page Down move a page at a time, as in the PDF viewer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        toggleMark(current);
        return;
      }
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
  }, [current, goTo, pages.length, toggleMark]);

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
            <li
              key={index}
              data-thumb={index + 1}
              className={`group relative ${marked.has(index + 1) ? "opacity-40" : ""}`}
            >
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
              {pages.length > 1 && (
                <button
                  type="button"
                  onClick={() => toggleMark(index + 1)}
                  title={marked.has(index + 1) ? t("Keep this page") : t("Delete this page")}
                  aria-label={marked.has(index + 1) ? t("Keep this page") : t("Delete this page")}
                  data-testid={`docx-mark-page-${index + 1}`}
                  className={`absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full text-[13px] font-semibold shadow transition-opacity ${
                    marked.has(index + 1)
                      ? "bg-ink-700 text-mist-100 opacity-100"
                      : "bg-red-600 text-white opacity-0 hover:bg-red-700 focus:opacity-100 group-hover:opacity-100"
                  }`}
                >
                  {marked.has(index + 1) ? "↺" : "×"}
                </button>
              )}
            </li>
          ))}
        </ul>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {(marked.size > 0 || notice) && (
          <EditorBar
            title={t("Deleting pages")}
            fileName={fileName}
            info={t("× on a thumbnail or the Delete key marks a page; Save writes a copy without it.")}
            changes={marked.size}
            saving={saving}
            saveLabel={t("Save as Word…")}
            notice={notice}
            onSave={() => void save()}
            onClose={() => {
              setMarked(new Set());
              setNotice(null);
            }}
          />
        )}
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-ink-850 px-3 text-[12px] text-mist-300">
          <span className="shrink-0 whitespace-nowrap font-mono" data-testid="docx-page-indicator">
            {pages.length > 0 ? `${current} / ${pages.length}` : "…"}
          </span>
          {pages.length > 1 && (
            <button
              type="button"
              className={`btn btn-ghost gap-1.5 ${marked.has(current) ? "" : "text-danger"}`}
              onClick={() => toggleMark(current)}
              data-testid="docx-delete-page"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {marked.has(current) ? t("Keep page") : t("Delete page")}
            </button>
          )}
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
