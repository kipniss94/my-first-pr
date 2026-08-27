import type { Metadata } from 'next';
import { LandingPage } from '@/components/site/LandingPage';

export const metadata: Metadata = {
  title: 'Online Office viewer — open DOCX, XLSX and PPTX without Office',
  description:
    'Free online viewer for Word, Excel and PowerPoint files. Open DOCX, XLSX, PPTX, DOC, XLS, PPT and OpenDocument files in the browser with formatting, tables and images intact.',
  keywords: [
    'online Word viewer',
    'DOCX viewer online',
    'Excel viewer online',
    'XLSX viewer',
    'PowerPoint viewer online',
    'PPTX viewer',
    'open Office files in browser',
  ],
  alternates: { canonical: '/office-viewer' },
  openGraph: {
    title: 'Online Office viewer — DOCX, XLSX, PPTX',
    description: 'Open Word, Excel and PowerPoint files in the browser.',
    url: '/office-viewer',
  },
};

export default function OfficeViewerLanding() {
  return (
    <LandingPage
      eyebrow="Office viewer"
      title="Word, Excel and PowerPoint without installing Office"
      intro="Word documents are converted to clean, selectable HTML with their headings, lists, tables and images. Workbooks open as a real grid with every sheet, merged cells and number formats. Presentations are rendered slide by slide through LibreOffice so the layout matches the original."
      kinds={['office']}
      capabilities={[
        { title: 'Documents stay readable', body: 'Headings, lists, tables and inline images survive the conversion, and the text remains selectable.' },
        { title: 'Exact page layout', body: 'Word and Excel files can also be rendered to their printed layout on demand, for when spacing matters.' },
        { title: 'Every sheet', body: 'Switch between worksheets, keep frozen headers in view, and read merged cells as they were laid out.' },
        { title: 'Number formats', body: 'Currency, percentages, dates and decimals are formatted the way the workbook defined them.' },
        { title: 'Slide navigation', body: 'A slide rail with titles, plus speaker notes read straight from the presentation file.' },
        { title: 'Nothing is executed', body: 'Macros are never run. A macro-enabled workbook opens as data, and only as data.' },
      ]}
      limitations={[
        'Legacy DOC, XLS, PPT and OpenDocument files need LibreOffice installed on the server. Without it the viewer says exactly that instead of failing.',
        'Charts and pivot tables inside spreadsheets are not drawn; their underlying cells are shown.',
        'Complex Word layouts (text boxes, multi-column sections, headers and footers) are simplified in the structural view — use the page layout view for those.',
        'Spreadsheet formulas are shown as their last calculated value; nothing is recalculated.',
      ]}
      faq={[
        {
          question: 'Do I need Microsoft Office?',
          answer: 'No. Files are converted on the server and rendered as web content in your browser.',
        },
        {
          question: 'Are macros a risk?',
          answer:
            'No. Uploaded files are never executed. Macro-enabled workbooks are parsed for their data only, and the macro code is ignored.',
        },
        {
          question: 'Why does my presentation look slightly different?',
          answer:
            'Slides are rendered by LibreOffice Impress. Layout, text and images are faithful, but exotic effects and some fonts can differ from PowerPoint.',
        },
        {
          question: 'Can I edit the document?',
          answer: 'Not in this stage — DocuView is a viewer. You can download the original file at any time.',
        },
      ]}
    />
  );
}
