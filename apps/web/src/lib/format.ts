import { currentLanguage, translatePlural } from './prefs';

/** Presentation helpers shared by every viewer, in the interface language. */

const RU_UNITS: Record<string, string> = {
  mm: 'мм',
  cm: 'см',
  m: 'м',
  km: 'км',
  in: 'дюйм',
  ft: 'фут',
  µm: 'мкм',
  um: 'мкм',
  B: 'Б',
  KB: 'КБ',
  MB: 'МБ',
  GB: 'ГБ',
  TB: 'ТБ',
};

const russian = () => currentLanguage() === 'ru';

/** A unit's name as the interface writes it: "mm", or "мм" in Russian. */
export function unitLabel(unit: string): string {
  return russian() ? (RU_UNITS[unit] ?? unit) : unit;
}

/** A number as text with the interface's decimal mark (a comma in Russian). */
export function decimal(text: string): string {
  return russian() ? text.replace('.', ',') : text;
}

const notAvailable = () => (russian() ? 'н/д' : 'N/A');

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} ${unitLabel('B')}`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${decimal(value >= 100 ? value.toFixed(0) : value.toFixed(1))} ${unitLabel(units[unit])}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString(russian() ? 'ru-RU' : 'en-US');
}

/**
 * Measurements are shown with a fixed number of significant digits rather than
 * fixed decimals: 0.05 mm and 1250 mm both need to read cleanly.
 */
export function formatLength(value: number, unit = 'mm'): string {
  if (!Number.isFinite(value)) return notAvailable();
  const absolute = Math.abs(value);
  let text: string;
  if (absolute === 0) text = '0';
  else if (absolute < 0.01) text = value.toExponential(2);
  else if (absolute < 10) text = value.toFixed(3);
  else if (absolute < 1000) text = value.toFixed(2);
  else text = value.toFixed(1);
  return `${decimal(text)} ${unitLabel(unit)}`;
}

export function formatAngle(degrees: number): string {
  if (!Number.isFinite(degrees)) return notAvailable();
  return `${decimal(degrees.toFixed(2))}°`;
}

/** Volumes and areas grow fast, so switch units instead of printing 9 digits. */
export function formatVolume(value: number, unit = 'mm'): string {
  if (!Number.isFinite(value)) return notAvailable();
  if (unit === 'mm' && Math.abs(value) >= 1e6) return `${decimal((value / 1e3).toFixed(2))} ${unitLabel('cm')}³`;
  return `${decimal(value.toFixed(Math.abs(value) < 10 ? 3 : 2))} ${unitLabel(unit)}³`;
}

export function formatArea(value: number, unit = 'mm'): string {
  if (!Number.isFinite(value)) return notAvailable();
  if (unit === 'mm' && Math.abs(value) >= 1e4) return `${decimal((value / 100).toFixed(2))} ${unitLabel('cm')}²`;
  return `${decimal(value.toFixed(Math.abs(value) < 10 ? 3 : 2))} ${unitLabel(unit)}²`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return translatePlural(Math.round(seconds), ['{n} second', '{n} seconds'], ['{n} секунда', '{n} секунды', '{n} секунд']);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return translatePlural(minutes, ['{n} minute', '{n} minutes'], ['{n} минута', '{n} минуты', '{n} минут']);
  const hours = Math.round(minutes / 60);
  return translatePlural(hours, ['{n} hour', '{n} hours'], ['{n} час', '{n} часа', '{n} часов']);
}

export function truncateMiddle(value: string, max = 42): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}
