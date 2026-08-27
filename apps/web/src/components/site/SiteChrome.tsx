import Link from 'next/link';

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="group flex items-center gap-2.5" aria-label="DocuView home">
      <span className="relative grid h-8 w-8 place-items-center rounded-lg bg-linear-to-br from-accent to-cyan shadow-[0_2px_12px_-2px_rgba(76,141,255,0.55)]">
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" aria-hidden="true">
          <path d="M4 8.2 12 4l8 4.2-8 4.2-8-4.2Z" fill="#04122e" opacity="0.9" />
          <path d="M4 12.4 12 16.6l8-4.2" stroke="#04122e" strokeWidth="1.7" fill="none" strokeLinejoin="round" />
          <path d="M4 16.2 12 20.4l8-4.2" stroke="#04122e" strokeWidth="1.7" fill="none" strokeLinejoin="round" opacity="0.55" />
        </svg>
      </span>
      {!compact && (
        <span className="text-[15px] font-semibold tracking-tight text-mist-100">
          Docu<span className="text-accent">View</span>
        </span>
      )}
    </Link>
  );
}

const NAV = [
  { href: '/cad-viewer', label: 'CAD viewer' },
  { href: '/pdf-viewer', label: 'PDF viewer' },
  { href: '/office-viewer', label: 'Office viewer' },
  { href: '/about', label: 'About' },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-ink-900/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-6 px-4 sm:px-6">
        <Logo />
        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 text-[13px] font-medium text-mist-300 transition-colors hover:bg-ink-800 hover:text-mist-100"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <Link href="/#upload" className="btn btn-primary">
          Open a file
        </Link>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-ink-950">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div className="max-w-sm">
            <Logo />
            <p className="mt-4 text-sm leading-relaxed text-mist-400">
              A fast browser viewer for engineering and office documents. Files are processed on the
              server, kept only as long as you need them, and never executed.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-10 sm:grid-cols-3">
            <FooterColumn
              title="Viewers"
              links={[
                { href: '/cad-viewer', label: 'CAD & 3D' },
                { href: '/pdf-viewer', label: 'PDF' },
                { href: '/office-viewer', label: 'Office' },
              ]}
            />
            <FooterColumn
              title="Formats"
              links={[
                { href: '/cad-viewer#formats', label: 'STEP & IGES' },
                { href: '/cad-viewer#formats', label: 'STL, OBJ, glTF' },
                { href: '/cad-viewer#formats', label: 'DXF & DWG' },
              ]}
            />
            <FooterColumn
              title="Legal"
              links={[
                { href: '/about', label: 'About' },
                { href: '/privacy', label: 'Privacy' },
                { href: '/terms', label: 'Terms' },
              ]}
            />
          </div>
        </div>
        <p className="mt-10 border-t border-line pt-6 text-xs text-mist-500">
          © {new Date().getFullYear()} DocuView. Stage 1 preview — see the About page for what is and
          is not supported today.
        </p>
      </div>
    </footer>
  );
}

function FooterColumn({ title, links }: { title: string; links: { href: string; label: string }[] }) {
  return (
    <div>
      <h2 className="field-label">{title}</h2>
      <ul className="mt-3 space-y-2">
        {links.map((link) => (
          <li key={`${link.href}${link.label}`}>
            <Link href={link.href} className="link-quiet text-sm">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
