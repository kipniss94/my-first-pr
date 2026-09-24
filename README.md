# DocuView

> **Windows, SOLIDWORKS, no CAD:** double-click `Start-DocuView.bat` — see
> [START-HERE.md](START-HERE.md) (in Russian). `.SLDPRT` parts open in 3D
> straight from the file, with no CAD installed anywhere;
> `Check-All-Models.bat` proves it on a whole folder of models.

A visual desktop for engineering documents. Drop a file anywhere and the right
viewer opens with the tools that format actually supports — 3D navigation,
sectioning and measurement for CAD, page rendering and search for PDF,
structural rendering for Word, Excel and PowerPoint.

The home page *is* the workspace: everything you have opened stays there as a
tile with its own preview, and clicking one opens it again immediately, without
sending the file anywhere. You never choose a document type or a viewer — the
format is read from the file itself.

Native CAD opens directly. A `.SLDPRT` or `.SLDASM` does not have to be saved
as STEP first: the file is opened from the preview and document properties it
carries, and an assembly asks for the components it references and draws them
as they arrive. Point `CAD_CONVERTER_CMD` at a converter you are licensed to
run and the same files arrive as full, measurable geometry instead.

No installation for the visitor, no account, no plugin.

---

## Quick start

```bash
npm install
npm run fixtures     # optional: generates test documents in ./fixtures
npm run dev
```

Open <http://localhost:3000>.

`npm run dev` starts both services: the API on port 4000 and the web app on
port 3000. The web app proxies `/api/v1/*` to the API, so the browser only ever
talks to one origin.

### With Docker

```bash
docker compose up --build
```

Same address. The image includes LibreOffice, so legacy Office formats and the
exact page-layout view work out of the box.

---

## Requirements

| What | Version | Needed for |
| --- | --- | --- |
| Node.js | 20.11 or newer (22 recommended) | everything |
| npm | 10 or newer | everything |
| LibreOffice | 7.x or newer, **with the writer, calc and impress packages** | DOC, XLS, PPT, OpenDocument, PowerPoint rendering, exact page layout |
| A DWG converter | ODA File Converter or LibreDWG | DWG files |

Nothing else is required. STEP and IGES are handled by a WebAssembly build of
OpenCascade that ships as an npm dependency — there is no native CAD kernel to
install.

**On Debian/Ubuntu:**

```bash
sudo apt install libreoffice-writer libreoffice-calc libreoffice-impress
```

Installing `libreoffice-core` alone is not enough: without the filter packages
every conversion fails with *"source file could not be loaded"*. The API checks
for this at start-up and warns you.

Without LibreOffice the app still runs. DOCX, XLSX, PDF and every CAD format
work; PPTX falls back to a simplified built-in renderer; DOC, XLS, PPT and
OpenDocument files report that the converter is missing.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API + web in watch mode |
| `npm run build` | Production build of all three packages |
| `npm start` | Run the production build |
| `npm test` | API unit tests (detection, storage safety, sanitising, queue, retention) |
| `npm run test:e2e` | Browser tests — needs the app running and fixtures generated |
| `npm run fixtures` | Generate test documents into `./fixtures` |
| `npm run typecheck` | TypeScript across the whole repo |
| `npm run clean` | Remove `node_modules`, build output and caches |

### Stopping

`Ctrl+C` in the terminal running `npm run dev` or `npm start` stops both
services. With Docker:

```bash
docker compose down          # stop
docker compose down -v       # stop and delete stored documents
```

### Production build

```bash
npm install
npm run build
NODE_ENV=production npm start
```

Put a reverse proxy in front of port 3000 and terminate TLS there. If the API
is exposed on its own hostname instead of through the Next.js proxy, set
`NEXT_PUBLIC_API_BASE` on the web app and add that origin to `CORS_ORIGINS` on
the API.

---

## Configuration

Copy `.env.example` to `.env`. Every setting has a working default; the ones
worth knowing about:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_UPLOAD_MB` | `250` | Largest accepted file |
| `RETENTION_MINUTES` | `60` | How long an upload survives before it is deleted |
| `PROCESSING_CONCURRENCY` | `2` | Documents processed at once |
| `PROCESSING_TIMEOUT_SECONDS` | `180` | Per-document wall-clock limit |
| `LIBREOFFICE_BIN` | auto-detected | Path to `soffice`, or `off` to disable |
| `DWG_CONVERTER_CMD` | unset | External DWG→DXF command |
| `CAD_CONVERTER_CMD` | unset | Licensed converter for SolidWorks/Inventor/CATIA/Parasolid → STEP |
| `NEXT_PUBLIC_ADS_ENABLED` | `false` | Render the reserved ad slots |

---

## How it is put together

```
packages/shared   Format registry and the API/viewer contracts.
                  The single source of truth for what is supported.

apps/api          Express service: upload, validation, job queue, storage,
                  retention sweeper, REST API.
  processing/     The processing layer. Runs in pooled child processes:
                  a parser crash cannot take the API down, and the memory
                  ceiling is enforced per document.

apps/web          Next.js app: the workspace and the viewers (client
                  rendered, code split so three.js and PDF.js only load when a
                  file needs them), plus the reference pages, which stay
                  server rendered for search engines.
  lib/cache.ts    The workspace's own store. Opened documents — bytes,
                  thumbnail and enough metadata to reopen — live in IndexedDB
                  on the visitor's machine and never leave it.
```

Every upload takes the same route:

```
Uploading → Detecting → Processing → Preparing geometry → Loading viewer → Ready
```

**Detection reads the file, not its name.** A `.stl` that contains prose opens
as text with a note saying so; a PDF renamed to `.step` opens as a PDF. This is
also what stops a renamed file from being promoted into a format it is not.

**Format support is declared in one place** — `packages/shared/src/formats.ts`.
The upload control, the API router, the reference tables and the docs all read
from it, so the UI cannot claim support the pipeline does not have. Native CAD
formats carry `support: 'preview'`, which is the honest label for "the document
opens, and what you are looking at is a picture, not geometry".

**Reopening is free while the job lives.** The workspace keeps every document
in IndexedDB. Clicking a tile reattaches to the server job that is still
holding the prepared geometry or pages, so nothing is uploaded and nothing is
processed again; once that job has expired the cached bytes are sent again
silently. Files are still deleted from the server on the same schedule as
before — the cache is on the visitor's machine, and one button clears it.

### Which engine handles what

| Area | Engine | Why |
| --- | --- | --- |
| STEP, IGES, BREP | OpenCascade via `occt-import-js` (server) | The only open-source kernel that reads these properly. Keeps the assembly tree and B-Rep face structure. |
| STL, OBJ, PLY, glTF, 3MF, FBX, COLLADA | three.js loaders (browser) | Already correct and maintained; parsing in the browser removes a round trip. |
| DXF | `dxf-parser` + a 2D canvas renderer (browser) | 2D drawings do not need WebGL. |
| DWG | External converter → DXF | No usable open-source DWG reader exists in JavaScript. |
| SolidWorks, Inventor, CATIA, Revit, JT | Compound-file reader + embedded preview, or `CAD_CONVERTER_CMD` → STEP | The solid model is a closed format, but the preview and property set beside it are documented — so the file opens, honestly labelled, instead of being refused. |
| PDF | PDF.js (browser) | The reference implementation. |
| Word | `mammoth` → HTML; LibreOffice for exact layout | Semantic HTML stays selectable and reflows; LibreOffice covers layout fidelity on demand. |
| Excel | `exceljs` → normalised grid | Gives styles, merges and number formats, rendered into a virtualised grid. |
| PowerPoint | LibreOffice → PDF, outline from the OOXML | Slide layout is the whole point of the format; the outline keeps the side panel useful. |

---

## Testing

```bash
npm run fixtures     # generate test documents
npm test             # API unit tests
npm run dev          # in another terminal
npm run test:e2e     # browser tests against the running app
```

The browser suite uploads about fifty documents in a minute, which is over the
production upload limit of twenty per device per minute. Raise it for the run:

```bash
RATE_LIMIT_UPLOADS=500 npm run dev
```

The fixtures are generated locally — a valid STEP assembly from
`scripts/step-builder.mjs`, and SolidWorks-shaped compound files from
`scripts/compound-file.mjs` — so the repository ships no third-party sample
files and the checks are reproducible. The compound-file builders are written
against the published container and property-set layouts and are shared by the
fixture script and the API tests, so both read exactly the same bytes.

`scripts/smoke-api.mjs` pushes every fixture through the real API and prints
what each one was detected as, how long it took and which viewer it routed to:

```bash
node scripts/smoke-api.mjs
```

If your environment cannot download Playwright's browsers, point it at one you
already have:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome npm run test:e2e
```

---

## Security posture

- Uploaded files are **never executed**. Macros are not run; a macro-enabled
  workbook is parsed for data only.
- Files are stored under generated names. The original name is metadata, and
  never touches the filesystem.
- Format is decided by content, with a size limit enforced during the upload
  and re-checked afterwards.
- Processing runs in separate OS processes with their own memory ceiling and
  timeout, and a minimal environment.
- Asset paths are allow-listed; nothing can escape a document's own directory.
- Generated document HTML is sanitised server-side and served as `text/plain`
  so a browser cannot execute it by navigating to the asset URL.
- Uploads are deleted automatically after the retention window, and can be
  deleted immediately from the viewer.
- Error messages shown to users never contain paths, stack traces or library
  names — those stay in the log.
- Proprietary CAD containers are **parsed as data**, never run: the reader
  walks a compound file's tables and validates every image it finds before
  emitting it, and every chain walk is bounded so a hostile or truncated file
  cannot spin a worker.
- `CAD_CONVERTER_CMD` is tokenised into argv and spawned **without a shell**;
  file names only ever arrive as whole arguments.
- The workspace cache is IndexedDB on the visitor's own machine. Nothing in it
  is uploaded, and clearing it is one button in the footer.

---

## Licence

The application code in this repository is provided as-is for evaluation.
Third-party engines keep their own licences — notably OpenCascade (LGPL-2.1
with an exception, via `occt-import-js`), three.js (MIT), PDF.js (Apache-2.0)
and LibreOffice (MPL-2.0), which is invoked as an external process and not
linked.
