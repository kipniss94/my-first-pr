import { SiteFooter, SiteHeader } from './SiteChrome';

interface ProsePageProps {
  title: string;
  subtitle?: string;
  updated?: string;
  children: React.ReactNode;
}

/** Shared shell for the text-only pages (about, privacy, terms). */
export function ProsePage({ title, subtitle, updated, children }: ProsePageProps) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <article className="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
          <h1 className="text-balance text-3xl font-semibold tracking-tight text-mist-100 sm:text-4xl">{title}</h1>
          {subtitle && <p className="mt-4 text-[17px] leading-relaxed text-mist-300">{subtitle}</p>}
          {updated && <p className="mt-3 text-xs text-mist-500">Last updated {updated}</p>}
          <div className="mt-10 space-y-8">{children}</div>
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-semibold tracking-tight text-mist-100">{title}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-mist-400 [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-4 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-mist-200 [&_li]:mb-1.5 [&_strong]:font-semibold [&_strong]:text-mist-200 [&_ul]:ml-5 [&_ul]:list-disc">
        {children}
      </div>
    </section>
  );
}

/** Placeholder banner: these documents are scaffolding, not legal advice. */
export function PlaceholderNotice() {
  return (
    <div className="rounded-xl border border-warn/35 bg-warn/10 px-4 py-3">
      <p className="text-sm font-medium text-mist-100">This is a placeholder document.</p>
      <p className="mt-1 text-[13px] leading-relaxed text-mist-400">
        It describes how the stage 1 build actually behaves, but it has not been reviewed by a
        lawyer. Replace it with a real policy before running this service publicly.
      </p>
    </div>
  );
}
