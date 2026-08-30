import type { Metadata } from 'next';
import { Workspace } from '@/components/desktop/Workspace';

export const metadata: Metadata = {
  title: 'DocuView — open CAD, PDF and Office documents in the browser',
  description:
    'A visual desktop for engineering documents. Drop a STEP, SolidWorks, DXF, PDF, Word, Excel or PowerPoint file and it opens straight away — rotate, section and measure 3D models, read pages and sheets. No installation, no account.',
  alternates: { canonical: '/' },
};

/**
 * The home page is the workspace itself.
 *
 * Everything a first-time visitor needs is the drop target and the documents
 * they have already opened; the explanatory pages are still there for search
 * engines and for anyone who wants them, one quiet link away in the footer.
 */
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
      'SolidWorks viewer',
      'PDF viewer',
      'Word, Excel and PowerPoint viewer',
      '3D measurement and sectioning',
    ],
  };

  return (
    <>
      <h1 className="sr-only">DocuView — open CAD, PDF and Office documents in your browser</h1>
      <Workspace />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  );
}
