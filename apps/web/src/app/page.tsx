import Link from 'next/link';
import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/site/SiteChrome';
import { FormatSummary } from '@/components/site/Formats';
import { AdSlot } from '@/components/site/AdSlot';
import { Dropzone } from '@/components/upload/Dropzone';

export const metadata: Metadata = {
  title: 'DocuView — Online CAD, PDF and Office viewer',
  description:
    'Open STEP, IGES, STL, DXF, PDF, Word, Excel and PowerPoint files straight in your browser. Rotate, section and measure 3D models. No installation, no account.',
  alternates: { canonical: '/' },
};

const STEPS = [
  { title: 'Drop the file', body: 'Drag it onto the page or pick it from your device. Nothing to install.' },
  { title: 'We identify it', body: 'The format is detected from the file contents, not from its name.' },
  { title: 'It opens', body: 'The right viewer loads with the tools that format actually supports.' },
];

const VIEWERS = [
  {
    href: '/cad-viewer',
    eyebrow: 'CAD & 3D',
    title: 'Inspect models, not just look at them',
    body: 'Orbit, section and measure STEP, IGES, STL, OBJ, glTF and DXF files. Assembly tree, per-part properties, clipping planes with hatched caps.',
    points: ['Standard views & fit', 'Distance, length and angle', 'Section planes with capping'],
  },
  {
    href: '/pdf-viewer',
    eyebrow: 'PDF',
    title: 'A PDF reader that gets out of the way',
    body: 'Page thumbnails, continuous scrolling, fit-width and fit-page zoom, full-text search, printing and fullscreen.',
    points: ['Text search across pages', 'Thumbnail navigation', 'Print and download'],
  },
  {
    href: '/office-viewer',
    eyebrow: 'Office',
    title: 'Word, Excel and PowerPoint without Office',
    body: 'Documents keep their headings, tables and images. Spreadsheets keep every sheet. Presentations are rendered slide by slide.',
    points: ['DOCX, XLSX, PPTX', 'Multi-sheet workbooks', 'Exact page layout on demand'],
  },
];

export default function HomePage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'DocuView',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Any browser with WebGL 2',
    description:
      'Online viewer for CAD, PDF and Office documents with 3D navigation, sectioning and measurement tools.',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    featureList: [
      'STEP viewer',
      'IGES viewer',
      'STL viewer',
      'DXF viewer',
      'PDF viewer',
      'Word, Excel and PowerPoint viewer',
      '3D measurement and sectioning',
    ],
  };

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />

      <main className="flex-1">
        <div className="mx-auto flex max-w-7xl justify-center px-4 pt-6 sm:px-6">
          <AdSlot placement="top" />
        </div>

        {/* Hero + upload: the whole product in one screen. */}
        <section className="relative overflow-hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(60%_100%_at_50%_0%,rgba(76,141,255,0.16),transparent_70%)]"
          />
          <div className="relative mx-auto max-w-3xl px-4 pt-14 pb-8 text-center sm:px-6 sm:pt-20">
            <p className="chip mx-auto">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" />
              Runs entirely in your browser session
            </p>
            <h1 className="mt-6 text-balance text-4xl font-semibold tracking-tight text-mist-100 sm:text-[3.25rem] sm:leading-[1.06]">
              Open any document. <span className="text-accent">Instantly.</span>
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-pretty text-[17px] leading-relaxed text-mist-300">
              CAD models, PDFs and Office files open straight in the browser — with the navigation,
              sectioning and measurement tools you would otherwise install a desktop application for.
            </p>
          </div>

          <div className="relative mx-auto max-w-3xl px-4 pb-16 sm:px-6">
            <Dropzone />
            <FormatSummary />
          </div>
        </section>

        {/* How it works */}
        <section aria-labelledby="how-it-works" className="border-y border-line bg-ink-950/60">
          <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
            <h2 id="how-it-works" className="text-center text-2xl font-semibold tracking-tight text-mist-100">
              From file to view in three steps
            </h2>
            <ol className="mx-auto mt-10 grid max-w-4xl gap-6 sm:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="panel p-5">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent-soft font-mono text-[13px] font-semibold text-accent-bright">
                    {index + 1}
                  </span>
                  <h3 className="mt-4 text-[15px] font-semibold text-mist-100">{step.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-mist-400">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Viewer cards */}
        <section aria-labelledby="viewers" className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
          <h2 id="viewers" className="text-2xl font-semibold tracking-tight text-mist-100">
            Three viewers, one upload box
          </h2>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-mist-400">
            The file decides which one opens. You never have to pick.
          </p>
          <div className="mt-8 grid gap-5 lg:grid-cols-3">
            {VIEWERS.map((viewer) => (
              <article key={viewer.href} className="panel flex flex-col p-6 transition-colors hover:border-line-strong">
                <p className="field-label text-accent">{viewer.eyebrow}</p>
                <h3 className="mt-3 text-lg font-semibold tracking-tight text-mist-100">{viewer.title}</h3>
                <p className="mt-2.5 flex-1 text-sm leading-relaxed text-mist-400">{viewer.body}</p>
                <ul className="mt-5 space-y-2">
                  {viewer.points.map((point) => (
                    <li key={point} className="flex items-start gap-2.5 text-[13px] text-mist-300">
                      <svg viewBox="0 0 16 16" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true">
                        <path d="M3 8.5 6.2 11.5 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      {point}
                    </li>
                  ))}
                </ul>
                <Link href={viewer.href} className="btn btn-ghost mt-6 self-start">
                  Learn more
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
                    <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
              </article>
            ))}
          </div>
        </section>

        {/* Honesty section: what this build does not do. */}
        <section aria-labelledby="stage-one" className="border-t border-line bg-ink-950/60">
          <div className="mx-auto max-w-3xl px-4 py-14 text-center sm:px-6">
            <h2 id="stage-one" className="text-xl font-semibold tracking-tight text-mist-100">
              What this build does — and doesn&apos;t — do
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-mist-400">
              Every format is labelled with what it really supports. Proprietary formats such as
              SolidWorks, Inventor and CATIA are recognised and named, but not rendered: you get a
              clear message and an export suggestion instead of a broken viewer.
            </p>
            <Link href="/about" className="btn btn-ghost mt-6">
              See the full support matrix
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </div>
  );
}
