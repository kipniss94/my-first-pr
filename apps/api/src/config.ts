import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repository root, works both from `src` (tsx) and `dist` (node). */
export const REPO_ROOT = path.resolve(here, '../../..');

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Locate a *usable* LibreOffice once at boot, so the UI can report the truth.
 *
 * The binary alone is not enough: distributions happily install
 * `libreoffice-core` without the Writer/Calc/Impress filter packages, and then
 * every conversion fails with "source file could not be loaded". Checking for
 * the filter registry turns that into an actionable startup warning instead of
 * a mysterious per-upload error.
 */
function findLibreOffice(): { bin: string | null; filters: string[] } {
  const explicit = process.env.LIBREOFFICE_BIN;
  if (explicit === 'off') return { bin: null, filters: [] };
  const candidates = explicit
    ? [explicit]
    : [
        '/usr/bin/soffice',
        '/usr/local/bin/soffice',
        '/opt/libreoffice/program/soffice',
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      ];
  const bin = candidates.find((candidate) => existsSync(candidate)) ?? null;
  if (!bin) return { bin: null, filters: [] };

  const registryDirs = [
    '/usr/lib/libreoffice/share/registry',
    '/usr/lib64/libreoffice/share/registry',
    '/usr/local/lib/libreoffice/share/registry',
    '/opt/libreoffice/share/registry',
    path.resolve(path.dirname(bin), '../share/registry'),
    path.resolve(path.dirname(bin), '../Resources/registry'),
  ];
  const found = new Set<string>();
  for (const dir of registryDirs) {
    for (const module of ['writer', 'calc', 'impress']) {
      if (existsSync(path.join(dir, `${module}.xcd`))) found.add(module);
    }
  }
  // No registry directory found at all: assume a working install (macOS and
  // some bundles lay the tree out differently) rather than disabling Office.
  const filters = found.size === 0 ? ['writer', 'calc', 'impress'] : [...found];
  return { bin, filters };
}

const libreOffice = findLibreOffice();

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num(process.env.API_PORT, 4000),
  host: process.env.API_HOST ?? '0.0.0.0',

  /** Absolute path where uploads and derived artifacts live. */
  dataDir: path.resolve(REPO_ROOT, process.env.DATA_DIR ?? 'data'),

  /** Hard upload ceiling. Enforced by multer and re-checked after the write. */
  maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 250) * 1024 * 1024,

  /** How long an uploaded file survives before the sweeper deletes it. */
  retentionSeconds: num(process.env.RETENTION_MINUTES, 60) * 60,

  /** How often the sweeper runs. */
  sweepIntervalSeconds: num(process.env.SWEEP_INTERVAL_SECONDS, 300),

  /** Concurrent processing child processes. */
  processingConcurrency: num(process.env.PROCESSING_CONCURRENCY, 2),

  /** Wall-clock limit for a single processing job. */
  processingTimeoutMs: num(process.env.PROCESSING_TIMEOUT_SECONDS, 180) * 1000,

  /** Memory ceiling handed to the processing child process. */
  processingMaxOldSpaceMb: num(process.env.PROCESSING_MAX_OLD_SPACE_MB, 3072),

  corsOrigins: list(process.env.CORS_ORIGINS, ['http://localhost:3000', 'http://127.0.0.1:3000']),

  rateLimit: {
    windowMs: num(process.env.RATE_LIMIT_WINDOW_SECONDS, 60) * 1000,
    uploads: num(process.env.RATE_LIMIT_UPLOADS, 20),
    api: num(process.env.RATE_LIMIT_API, 600),
  },

  libreOfficeBin: libreOffice.bin,
  /** Which document families LibreOffice can actually convert on this host. */
  libreOfficeFilters: libreOffice.filters,

  /**
   * Optional external DWG→DXF converter. `{input}` and `{outdir}` are replaced.
   * Example: `/usr/bin/ODAFileConverter {indir} {outdir} ACAD2018 DXF 0 1`
   */
  dwgConverterCmd: process.env.DWG_CONVERTER_CMD?.trim() || null,

  /**
   * Optional licensed converter for native CAD formats (SolidWorks, Inventor,
   * CATIA, Parasolid). When set, those uploads are converted to STEP and gain
   * full geometry; when unset they open from the preview stored in the file.
   * `{input}`, `{output}`, `{outdir}`, `{informat}` are replaced.
   */
  cadConverterCmd: process.env.CAD_CONVERTER_CMD?.trim() || null,

  prettyLogs: bool(process.env.PRETTY_LOGS, process.env.NODE_ENV !== 'production'),
  logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;

export const uploadsDir = path.join(config.dataDir, 'uploads');
export const tmpDir = path.join(config.dataDir, 'tmp');
