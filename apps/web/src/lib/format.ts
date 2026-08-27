/** Presentation helpers shared by every viewer. */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Measurements are shown with a fixed number of significant digits rather than
 * fixed decimals: 0.05 mm and 1250 mm both need to read cleanly.
 */
export function formatLength(value: number, unit = 'mm'): string {
  if (!Number.isFinite(value)) return 'N/A';
  const absolute = Math.abs(value);
  let text: string;
  if (absolute === 0) text = '0';
  else if (absolute < 0.01) text = value.toExponential(2);
  else if (absolute < 10) text = value.toFixed(3);
  else if (absolute < 1000) text = value.toFixed(2);
  else text = value.toFixed(1);
  return `${text} ${unit}`;
}

export function formatAngle(degrees: number): string {
  if (!Number.isFinite(degrees)) return 'N/A';
  return `${degrees.toFixed(2)}°`;
}

/** Volumes and areas grow fast, so switch units instead of printing 9 digits. */
export function formatVolume(value: number, unit = 'mm'): string {
  if (!Number.isFinite(value)) return 'N/A';
  if (unit === 'mm' && Math.abs(value) >= 1e6) return `${(value / 1e3).toFixed(2)} cm³`;
  return `${value.toFixed(Math.abs(value) < 10 ? 3 : 2)} ${unit}³`;
}

export function formatArea(value: number, unit = 'mm'): string {
  if (!Number.isFinite(value)) return 'N/A';
  if (unit === 'mm' && Math.abs(value) >= 1e4) return `${(value / 100).toFixed(2)} cm²`;
  return `${value.toFixed(Math.abs(value) < 10 ? 3 : 2)} ${unit}²`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

export function truncateMiddle(value: string, max = 42): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}
