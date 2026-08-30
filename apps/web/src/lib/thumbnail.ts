'use client';

/** Longest edge of a workspace thumbnail, in device pixels. */
export const THUMBNAIL_EDGE = 384;

/**
 * Scale a canvas that is already on screen down into a PNG data URL.
 *
 * Taking the picture from the canvas the viewer has drawn — rather than
 * rendering the document a second time — means the card is exactly what the
 * reader saw, and it cannot collide with the renderer that owns that page.
 */
export function captureCanvas(canvas: HTMLCanvasElement, edge = THUMBNAIL_EDGE): string | null {
  if (canvas.width === 0 || canvas.height === 0) return null;
  try {
    const scale = Math.min(1, edge / Math.max(canvas.width, canvas.height));
    const target = document.createElement('canvas');
    target.width = Math.max(1, Math.round(canvas.width * scale));
    target.height = Math.max(1, Math.round(canvas.height * scale));
    const context = target.getContext('2d');
    if (!context) return null;
    context.drawImage(canvas, 0, 0, target.width, target.height);
    return target.toDataURL('image/png');
  } catch {
    // A tainted canvas, or a context the browser has dropped under memory
    // pressure. A missing thumbnail is not worth surfacing.
    return null;
  }
}

/**
 * Wait for a canvas to appear and have something on it, then capture it.
 *
 * Returns a cancel function. Gives up quietly after `timeoutMs` — some
 * documents legitimately never produce one.
 */
export function captureWhenDrawn(
  selector: string,
  onCapture: (dataUrl: string) => void,
  timeoutMs = 15_000,
): () => void {
  let cancelled = false;
  const deadline = Date.now() + timeoutMs;

  const attempt = (): void => {
    if (cancelled) return;
    const canvas = document.querySelector<HTMLCanvasElement>(selector);
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      const shot = captureCanvas(canvas);
      if (shot) {
        onCapture(shot);
        return;
      }
    }
    if (Date.now() < deadline) setTimeout(attempt, 400);
  };

  setTimeout(attempt, 400);
  return () => {
    cancelled = true;
  };
}
