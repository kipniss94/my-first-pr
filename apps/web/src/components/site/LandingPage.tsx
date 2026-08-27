import Link from 'next/link';
import type { FormatDescriptor } from '@docuview/shared';
import { SiteFooter, SiteHeader } from './SiteChrome';
import { FormatTable, SupportLegend } from './Formats';
import { AdSlot } from './AdSlot';
import { Dropzone } from '@/components/upload/Dropzone';

export interface LandingSection {
  title: string;
  body: string;
}

export interface LandingFaq {
  question: string;
  answer: string;
}

interface LandingPageProps {
  eyebrow: string;
  title: string;
  intro: string;
  kinds: FormatDescriptor['kind'][];
  capabilities: LandingSection[];
  limitations: string[];
  faq: LandingFaq[];
}

/**
 * Shared structure for the per-viewer landing pages. These are server rendered
 * with real prose so search engines index something meaningful, and they carry
 * the same upload box as the home page — a visitor never has to navigate back.
 */
export function LandingPage({ eyebrow, title, intro, kinds, capabilities, limitations, faq }: LandingPageProps) {
  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <div className="mx-auto flex max-w-7xl justify-center px-4 pt-6 sm:px-6">
          <AdSlot placement="top" />
        </div>

        <section className="mx-auto max-w-3xl px-4 pt-12 pb-8 sm:px-6 sm:pt-16">
          <p className="field-label text-accent">{eyebrow}</p>
          <h1 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-mist-100 sm:text-[2.75rem] sm:leading-[1.1]">
            {title}
          </h1>
          <p className="mt-5 text-pretty text-[17px] leading-relaxed text-mist-300">{intro}</p>
        </section>

        <section className="mx-auto max-w-3xl px-4 pb-14 sm:px-6">
          <Dropzone compact />
        </section>

        <section aria-labelledby="capabilities" className="border-y border-line bg-ink-950/60">
          <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
            <h2 id="capabilities" className="text-2xl font-semibold tracking-tight text-mist-100">
              What you can do
            </h2>
            <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {capabilities.map((item) => (
                <article key={item.title} className="panel p-5">
                  <h3 className="text-[15px] font-semibold text-mist-100">{item.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-mist-400">{item.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="formats" className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
          <h2 id="formats" className="text-2xl font-semibold tracking-tight text-mist-100">
            Formats and current status
          </h2>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-mist-400">
            This table is generated from the same registry that routes uploads, so it cannot drift
            from what the app really does.
          </p>
          <div className="mt-6">
            <FormatTable kinds={kinds} />
          </div>
          <SupportLegend />
        </section>

        <section aria-labelledby="limits" className="border-t border-line bg-ink-950/60">
          <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
            <h2 id="limits" className="text-2xl font-semibold tracking-tight text-mist-100">
              Known limitations
            </h2>
            <ul className="mt-6 grid max-w-4xl gap-3">
              {limitations.map((limitation) => (
                <li key={limitation} className="flex items-start gap-3 text-[14px] leading-relaxed text-mist-300">
                  <svg viewBox="0 0 16 16" className="mt-1 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M8 4.8v4M8 10.9v.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                  {limitation}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="faq" className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
          <h2 id="faq" className="text-2xl font-semibold tracking-tight text-mist-100">
            Questions
          </h2>
          <dl className="mt-8 space-y-6">
            {faq.map((item) => (
              <div key={item.question} className="border-b border-line pb-6 last:border-0">
                <dt className="text-[15px] font-semibold text-mist-100">{item.question}</dt>
                <dd className="mt-2 text-sm leading-relaxed text-mist-400">{item.answer}</dd>
              </div>
            ))}
          </dl>
          <Link href="/#upload" className="btn btn-primary mt-8">
            Open a file now
          </Link>
        </section>
      </main>
      <SiteFooter />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />
    </div>
  );
}
