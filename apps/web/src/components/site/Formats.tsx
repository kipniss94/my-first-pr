import { FORMATS, type FormatDescriptor, type SupportLevel } from '@docuview/shared';

const SUPPORT_COPY: Record<SupportLevel, { label: string; className: string; hint: string }> = {
  full: {
    label: 'Supported',
    className: 'border-ok/40 bg-ok/10 text-ok',
    hint: 'Opens directly, verified against real files.',
  },
  partial: {
    label: 'Partial',
    className: 'border-accent/40 bg-accent/10 text-accent-bright',
    hint: 'Opens, but some entities or features are not rendered.',
  },
  conversion: {
    label: 'Needs converter',
    className: 'border-warn/40 bg-warn/10 text-warn',
    hint: 'Opens only when the matching converter is installed on the server.',
  },
  preview: {
    label: 'Preview',
    className: 'border-accent/40 bg-accent/10 text-accent-bright',
    hint: 'Opens from the preview and properties stored inside the file. Measurable geometry needs a server-side converter.',
  },
  planned: {
    label: 'Not yet',
    className: 'border-line-strong bg-ink-800 text-mist-400',
    hint: 'Recognised and named, but not rendered. Export to STEP instead.',
  },
};

export function SupportBadge({ level }: { level: SupportLevel }) {
  const copy = SUPPORT_COPY[level];
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${copy.className}`}>
      {copy.label}
    </span>
  );
}

/** The short "Supported formats" line under the upload box. */
export function FormatSummary() {
  const groups = ['CAD', '3D', 'PDF', 'Word', 'Excel', 'PowerPoint'] as const;
  return (
    <section aria-labelledby="supported-formats" className="mt-10">
      <h2 id="supported-formats" className="text-center field-label">
        Supported formats
      </h2>
      <ul className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {groups.map((group) => {
          const items = FORMATS.filter((format) => format.group === group && format.pipeline !== 'unsupported');
          if (items.length === 0) return null;
          return (
            <li key={group} className="chip">
              <span className="font-medium text-mist-100">{group === '3D' ? '3D models' : group}</span>
              <span className="text-mist-500">
                {items
                  .flatMap((item) => item.extensions)
                  .slice(0, 4)
                  .map((extension) => extension.toUpperCase())
                  .join(' · ')}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface FormatTableProps {
  /** Restrict to one document family; omit for everything. */
  kinds?: FormatDescriptor['kind'][];
  id?: string;
}

/**
 * The honest support matrix, generated from the same registry the backend uses
 * to route files. If a format is not wired up, this table says so.
 */
export function FormatTable({ kinds, id }: FormatTableProps) {
  const rows = FORMATS.filter((format) => !kinds || kinds.includes(format.kind));
  const rank: Record<SupportLevel, number> = { full: 0, partial: 1, preview: 2, conversion: 3, planned: 4 };
  rows.sort((a, b) => rank[a.support] - rank[b.support] || a.label.localeCompare(b.label));

  return (
    <div id={id} className="scroll-mt-24 overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <caption className="sr-only">Supported file formats and their current status</caption>
        <thead>
          <tr className="bg-ink-850">
            <th scope="col" className="px-4 py-3 field-label">Format</th>
            <th scope="col" className="px-4 py-3 field-label">Extensions</th>
            <th scope="col" className="px-4 py-3 field-label">Status</th>
            <th scope="col" className="px-4 py-3 field-label">How it opens</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((format) => (
            <tr key={format.id} className="border-t border-line align-top">
              <th scope="row" className="whitespace-nowrap px-4 py-3 font-medium text-mist-100">
                {format.label}
              </th>
              <td className="px-4 py-3 font-mono text-[12px] text-mist-400">
                {format.extensions.map((extension) => `.${extension}`).join(' ')}
              </td>
              <td className="px-4 py-3">
                <SupportBadge level={format.support} />
              </td>
              <td className="px-4 py-3 text-[13px] leading-relaxed text-mist-400">
                {format.note ??
                  (format.pipeline === 'client'
                    ? 'Parsed directly in the browser.'
                    : format.pipeline === 'server'
                      ? 'Prepared by the processing service.'
                      : 'Not rendered yet.')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SupportLegend() {
  return (
    <dl className="mt-4 grid gap-3 sm:grid-cols-2">
      {(Object.keys(SUPPORT_COPY) as SupportLevel[]).map((level) => (
        <div key={level} className="flex items-start gap-3">
          <dt className="shrink-0">
            <SupportBadge level={level} />
          </dt>
          <dd className="text-[13px] leading-relaxed text-mist-400">{SUPPORT_COPY[level].hint}</dd>
        </div>
      ))}
    </dl>
  );
}
