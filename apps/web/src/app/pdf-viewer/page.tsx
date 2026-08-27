import type { Metadata } from 'next';
import { LandingPage } from '@/components/site/LandingPage';

export const metadata: Metadata = {
  title: 'Online PDF viewer — read, search and print PDFs in the browser',
  description:
    'Free online PDF viewer. Open a PDF, browse page thumbnails, zoom to fit width or page, search the full text, print or download — nothing to install.',
  keywords: ['PDF viewer online', 'open PDF in browser', 'read PDF online', 'PDF reader', 'search PDF text'],
  alternates: { canonical: '/pdf-viewer' },
  openGraph: {
    title: 'Online PDF viewer',
    description: 'Open, search and print PDF files in the browser.',
    url: '/pdf-viewer',
  },
};

export default function PdfViewerLanding() {
  return (
    <LandingPage
      eyebrow="PDF viewer"
      title="Read any PDF in the browser"
      intro="Drop a PDF and it renders immediately with PDF.js — the same engine Firefox ships. Pages stream in as you scroll, thumbnails let you jump anywhere, and full-text search highlights every match across the document."
      kinds={['pdf']}
      capabilities={[
        { title: 'Continuous pages', body: 'Scroll through the document naturally; pages render as they come into view.' },
        { title: 'Thumbnail rail', body: 'A page overview you can collapse, with the current page always highlighted.' },
        { title: 'Zoom that makes sense', body: 'Fit width, fit page, or step through fixed zoom levels. Ctrl/⌘ and scroll works too.' },
        { title: 'Full-text search', body: 'Find text across every page, step between matches, and see how many there are.' },
        { title: 'Print and download', body: 'Send the original file to your printer or save it back to your device.' },
        { title: 'Fullscreen reading', body: 'Hide the chrome and use the whole screen for the page.' },
      ]}
      limitations={[
        'Encrypted PDFs that require a password cannot be opened; we say so rather than failing silently.',
        'Interactive form filling and digital signature validation are not part of stage 1.',
        'Annotations are rendered as part of the page but cannot be edited.',
      ]}
      faq={[
        {
          question: 'Is the PDF uploaded anywhere?',
          answer:
            'The file is stored on the server for the session so the viewer can stream it, and is deleted automatically afterwards. Rendering itself happens in your browser.',
        },
        {
          question: 'Can I search inside scanned documents?',
          answer:
            'Only if the scan already contains a text layer (searchable PDF). Pages that are pure images have no text to search; OCR is not part of this stage.',
        },
        {
          question: 'How large a PDF can I open?',
          answer: 'Up to the upload limit shown on the upload box. Large documents render page by page, so memory stays reasonable.',
        },
      ]}
    />
  );
}
