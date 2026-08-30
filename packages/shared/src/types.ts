/**
 * Contracts shared between the web frontend, the API and the processing layer.
 * Keeping them in one package guarantees the UI can never claim support for a
 * format the pipeline does not actually handle.
 */

/** High level document family. Determines which viewer the frontend mounts. */
export type DocumentKind = 'cad' | 'pdf' | 'office' | 'image' | 'unknown';

/**
 * How a format reaches the browser.
 *  - `client`      : the raw file is streamed to the browser and parsed there.
 *  - `server`      : the processing layer converts it into a normalized artifact.
 *  - `unsupported` : recognised, but no engine is wired up yet (honest stub).
 */
export type PipelineKind = 'client' | 'server' | 'unsupported';

/**
 * Truthful support level, surfaced verbatim in the UI and in the docs.
 *
 * `preview` is the honest label for a proprietary format we open from the image
 * its own CAD system stored inside the file: the document is genuinely shown,
 * but there is no geometry behind it to measure or section.
 */
export type SupportLevel = 'full' | 'partial' | 'conversion' | 'preview' | 'planned';

export interface FormatDescriptor {
  /** Stable machine id, e.g. `step`. */
  id: string;
  /** Human label, e.g. `STEP`. */
  label: string;
  kind: DocumentKind;
  /** Lower-case extensions, without the dot. */
  extensions: string[];
  /** MIME types browsers commonly report for this format. */
  mimeTypes: string[];
  pipeline: PipelineKind;
  support: SupportLevel;
  /**
   * Name of the processor that handles the format server side.
   * `null` for client-parsed formats.
   */
  processor: string | null;
  /** Short note rendered in the UI next to the format. */
  note?: string;
  /** Marketing-facing group used on the landing pages. */
  group: 'CAD' | '3D' | 'PDF' | 'Word' | 'Excel' | 'PowerPoint' | 'Image';
}

/* -------------------------------------------------------------------------- */
/* Jobs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * User visible pipeline stages. The order here is the order shown in the
 * progress rail, so it must stay monotonic.
 */
export const JOB_STAGES = [
  'uploading',
  'detecting',
  'processing',
  'preparing-geometry',
  'loading-viewer',
  'ready',
] as const;

export type JobStage = (typeof JOB_STAGES)[number];

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobError {
  /** Machine readable code, e.g. `unsupported_format`. */
  code: string;
  /** Sentence shown to the user. Never contains stack traces or paths. */
  message: string;
  /** Optional actionable hint, e.g. how to install a missing engine. */
  hint?: string;
  /** Whether a retry could plausibly succeed. */
  retryable: boolean;
}

export interface DetectedFormat {
  formatId: string;
  label: string;
  kind: DocumentKind;
  pipeline: PipelineKind;
  support: SupportLevel;
  /** e.g. `AP214`, `PDF 1.7`, `AutoCAD 2018 (AC1032)`. `null` when unknown. */
  version: string | null;
  /** True when the extension disagreed with the sniffed content. */
  extensionMismatch: boolean;
}

export interface JobState {
  id: string;
  fileId: string;
  fileName: string;
  size: number;
  status: JobStatus;
  stage: JobStage;
  /** 0..100 for the current stage; -1 when indeterminate. */
  progress: number;
  createdAt: string;
  updatedAt: string;
  format: DetectedFormat | null;
  result: JobResult | null;
  error: JobError | null;
  /**
   * Component resolution for an assembly. Present only once the document turned
   * out to reference other files; the viewer builds the model as they arrive.
   */
  assembly: AssemblyState | null;
  /** Expiry of the stored file, ISO timestamp. */
  expiresAt: string;
}

/** What the viewer needs in order to render the document. */
export interface JobResult {
  kind: DocumentKind;
  /** Which viewer component to mount. */
  viewer: ViewerId;
  /** Relative API path of the primary asset the viewer should load. */
  source: string;
  /** Extra viewer specific payload (sheet list, slide count, warnings...). */
  meta: Record<string, unknown>;
  /** Non fatal issues worth telling the user about. */
  warnings: string[];
}

export type ViewerId =
  | 'cad-mesh' // three.js scene fed from a normalized geometry document
  | 'cad-nmg' // server-normalized geometry (STEP/IGES/BREP)
  | 'cad-dxf' // 2D DXF vector viewer
  | 'cad-preview' // native CAD opened from its stored preview and properties
  | 'pdf'
  | 'office-word'
  | 'office-sheet'
  | 'office-slides'
  | 'image'
  | 'none';

/* -------------------------------------------------------------------------- */
/* Normalized geometry document (NMG)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Minimal, viewer-agnostic geometry container produced by the processing layer.
 * A manifest (JSON) plus a single binary blob keeps parsing cheap in the
 * browser and lets us swap the CAD engine without touching the viewer.
 */
export interface NmgManifest {
  version: 1;
  /** Source unit as reported by the CAD engine; `mm` when unknown. */
  units: string;
  /** Bounding box in model units. */
  bbox: { min: [number, number, number]; max: [number, number, number] };
  buffer: { uri: string; byteLength: number };
  meshes: NmgMesh[];
  nodes: NmgNode[];
  /** Index of the root nodes inside `nodes`. */
  roots: number[];
  stats: { meshes: number; triangles: number; vertices: number };
  /** Engine that produced the document, e.g. `occt-import-js 0.0.23`. */
  producer: string;
  warnings: string[];
}

export interface NmgAccessor {
  /** Byte offset into the buffer. */
  offset: number;
  /** Number of scalar elements (not bytes). */
  count: number;
}

export interface NmgMesh {
  id: number;
  name: string;
  /** Float32, 3 components per vertex. */
  position: NmgAccessor;
  /** Float32, 3 components per vertex. Optional: viewer computes if absent. */
  normal?: NmgAccessor;
  /** Uint32, 3 per triangle. */
  index: NmgAccessor;
  /** sRGB hex, e.g. `#b0b7c3`. */
  color?: string;
  /**
   * Flat pairs of `[firstTriangle, lastTriangle]` describing the B-Rep faces the
   * mesh was tessellated from. Lets the viewer highlight a single CAD face
   * instead of the whole solid. Absent for mesh-native formats.
   */
  faceRanges?: number[];
}

export interface NmgNode {
  id: number;
  name: string;
  parent: number | null;
  children: number[];
  meshes: number[];
}

/* -------------------------------------------------------------------------- */
/* Office payloads                                                            */
/* -------------------------------------------------------------------------- */

export interface SheetDocument {
  sheets: SheetData[];
  producer: string;
  warnings: string[];
}

export interface SheetData {
  name: string;
  rowCount: number;
  colCount: number;
  /** Column widths in character units, index aligned with columns. */
  colWidths: number[];
  rowHeights: number[];
  cells: SheetCell[];
  merges: { top: number; left: number; bottom: number; right: number }[];
}

export interface SheetCell {
  /** 1-based row. */
  r: number;
  /** 1-based column. */
  c: number;
  /** Display text, already formatted. */
  t: string;
  /** Cell type, used for alignment defaults. */
  ty: 'string' | 'number' | 'date' | 'bool' | 'formula' | 'error';
  s?: SheetCellStyle;
}

export interface SheetCellStyle {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  /** Text colour, hex. */
  fg?: string;
  /** Background colour, hex. */
  bg?: string;
  /** Horizontal alignment. */
  ha?: 'left' | 'center' | 'right';
  /** Font size in points. */
  fs?: number;
}

export interface SlideDocument {
  /** Slide size in EMU-derived pixels (96 dpi). */
  width: number;
  height: number;
  slides: SlideData[];
  producer: string;
  warnings: string[];
}

export interface SlideData {
  index: number;
  title: string | null;
  notes: string | null;
  shapes: SlideShape[];
}

export interface SlideShape {
  type: 'text' | 'image' | 'rect' | 'line';
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
  fill?: string;
  stroke?: string;
  /** Asset path for images. */
  src?: string;
  paragraphs?: SlideParagraph[];
}

export interface SlideParagraph {
  align: 'left' | 'center' | 'right' | 'justify';
  bullet: boolean;
  level: number;
  runs: SlideRun[];
}

export interface SlideRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  size?: number;
  color?: string;
  font?: string;
}

/* -------------------------------------------------------------------------- */
/* API responses                                                              */
/* -------------------------------------------------------------------------- */

export interface UploadResponse {
  fileId: string;
  jobId: string;
  job: JobState;
}

export interface ApiErrorBody {
  error: JobError;
}

export interface CapabilitiesResponse {
  /** Max upload size in bytes. */
  maxUploadBytes: number;
  /** File retention in seconds. */
  retentionSeconds: number;
  /** Whether a LibreOffice binary was found on the processing host. */
  libreOffice: boolean;
  /** Whether an external DWG converter has been configured. */
  dwgConverter: boolean;
  /**
   * Whether a licensed native-CAD converter is configured. When false,
   * SolidWorks/Inventor/CATIA files open as their stored preview, and the UI
   * says so rather than implying measurable geometry.
   */
  cadConverter: boolean;
  formats: FormatDescriptor[];
}

/* -------------------------------------------------------------------------- */
/* Native (proprietary) CAD                                                   */
/* -------------------------------------------------------------------------- */

/** What a component of an assembly is doing right now. */
export type ComponentStatus = 'missing' | 'pending' | 'ready' | 'failed';

export interface AssemblyComponent {
  /** File name exactly as the assembly refers to it. */
  name: string;
  status: ComponentStatus;
  /** Job that is preparing this component, once one has been supplied. */
  jobId: string | null;
  fileId: string | null;
}

export interface AssemblyState {
  /** `assembly` once the document turned out to reference other files. */
  role: NativeCadRole;
  components: AssemblyComponent[];
  updatedAt: string;
}

export type NativeCadRole = 'part' | 'assembly' | 'drawing' | 'unknown';

/**
 * A proprietary CAD document opened without its vendor kernel.
 *
 * `geometry` says plainly what is behind the picture: `preview-only` means the
 * stored preview image, with no solid to measure. When a server-side converter
 * is configured the document never reaches this shape at all — it goes through
 * the normal STEP path instead.
 */
export interface NativeCadDocument {
  application: string;
  version: string | null;
  role: NativeCadRole;
  preview: { url: string; width: number; height: number; contentType: string } | null;
  properties: { name: string; value: string }[];
  components: AssemblyComponent[];
  geometry: 'preview-only';
  /** One paragraph, shown verbatim in the viewer. */
  note: string;
}
