import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import { PrefsProvider } from '@/lib/prefs';
import { LANG_COOKIE, THEME_COOKIE, type Lang, type Theme } from '@/lib/prefs-keys';
import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'DocuView — Online CAD, PDF and Office viewer',
    template: '%s — DocuView',
  },
  description:
    'Open STEP, IGES, STL, DXF, PDF, Word, Excel and PowerPoint files straight in your browser. Rotate and section 3D models, measure geometry, read documents — no software to install.',
  applicationName: 'DocuView',
  keywords: [
    'online CAD viewer',
    'STEP viewer online',
    'STP viewer',
    'IGES viewer',
    'DXF viewer',
    'DWG viewer',
    'STL viewer',
    '3D model viewer',
    'PDF viewer online',
    'online document viewer',
  ],
  authors: [{ name: 'DocuView' }],
  openGraph: {
    type: 'website',
    siteName: 'DocuView',
    title: 'DocuView — Online CAD, PDF and Office viewer',
    description:
      'Open STEP, IGES, STL, DXF, PDF and Office files in the browser. Rotate, section and measure 3D models without installing anything.',
    url: siteUrl,
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DocuView — Online CAD, PDF and Office viewer',
    description: 'Open CAD, PDF and Office documents in your browser. No installation.',
  },
  robots: { index: true, follow: true },
  alternates: { canonical: '/' },
};

export const viewport: Viewport = {
  themeColor: '#0b0e14',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The visitor's choices, so the first paint is already in their language
  // and theme. Nothing chosen yet: dark, and English unless the browser asks
  // for Russian (the toggle then remembers whatever is picked).
  const store = await cookies();
  const langCookie = store.get(LANG_COOKIE)?.value;
  const asked = (await headers()).get('accept-language') ?? '';
  const lang: Lang = langCookie === 'ru' || langCookie === 'en' ? langCookie : /^ru/i.test(asked) ? 'ru' : 'en';
  const theme: Theme = store.get(THEME_COOKIE)?.value === 'light' ? 'light' : 'dark';

  return (
    <html lang={lang} data-theme={theme} style={{ colorScheme: theme }}>
      <body className="min-h-full antialiased">
        <PrefsProvider lang={lang} theme={theme}>
          {children}
        </PrefsProvider>
      </body>
    </html>
  );
}
