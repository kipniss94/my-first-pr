import type { Metadata, Viewport } from 'next';
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
