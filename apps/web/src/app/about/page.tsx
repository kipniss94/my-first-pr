import type { Metadata } from 'next';
import Link from 'next/link';
import { ProsePage, Section } from '@/components/site/ProsePage';
import { FormatTable, SupportLegend } from '@/components/site/Formats';

export const metadata: Metadata = {
  title: 'About DocuView — how the viewer works',
  description:
    'How DocuView opens CAD, PDF and Office documents: format detection, the processing pipeline, the engines behind each viewer, and exactly which formats are supported today.',
  alternates: { canonical: '/about' },
};

export default function AboutPage() {
  return (
    <ProsePage
      title="About DocuView"
      subtitle="A browser viewer for engineering and office documents, built so that opening a file is the only thing you have to do."
    >
      <Section title="The idea">
        <p>
          Opening a CAD model usually means installing something. A colleague sends a STEP file, a
          supplier sends a DXF, a customer sends a PPTX — and each one wants its own application.
          DocuView collapses that into a single step: drop the file, and the right viewer opens with
          the tools that format genuinely supports.
        </p>
      </Section>

      <Section title="How a file is handled">
        <p>Every upload goes through the same five stages, and the interface names each one as it happens:</p>
        <ul>
          <li>
            <strong>Uploading</strong> — the browser streams the file to the API with real progress,
            and you can cancel at any point.
          </li>
          <li>
            <strong>Detecting</strong> — the format is identified from the file&apos;s contents, not its
            name. A <code>.stl</code> that is really a text file is opened as text, and told you so.
          </li>
          <li>
            <strong>Processing</strong> — formats that need a server-side engine are handed to an
            isolated worker process. A parser crash there can never take down the API.
          </li>
          <li>
            <strong>Preparing geometry</strong> — CAD models are normalised into a compact binary
            format the browser can hand straight to WebGL.
          </li>
          <li>
            <strong>Loading viewer</strong> — the matching viewer is code-split, so the heavy 3D and
            PDF libraries are only downloaded when a file actually needs them.
          </li>
        </ul>
      </Section>

      <Section title="What each viewer is built on">
        <ul>
          <li>
            <strong>CAD and 3D</strong> — three.js for rendering. STEP, IGES and BREP files are
            tessellated server-side by OpenCascade (through <code>occt-import-js</code>), which keeps
            the assembly tree and B-Rep face structure intact. Mesh formats are parsed in the
            browser.
          </li>
          <li>
            <strong>PDF</strong> — PDF.js, rendering straight from the stored file.
          </li>
          <li>
            <strong>Word</strong> — mammoth converts DOCX to semantic HTML; LibreOffice provides the
            exact page layout on request and handles legacy formats.
          </li>
          <li>
            <strong>Excel</strong> — ExcelJS reads the workbook into a normalised grid with styles,
            merges and number formats.
          </li>
          <li>
            <strong>PowerPoint</strong> — LibreOffice Impress renders the slides; the outline and
            speaker notes are read directly from the OOXML so the side panel stays useful.
          </li>
        </ul>
      </Section>

      <Section title="What is supported today">
        <p>
          The table below is generated from the same registry the backend uses to route uploads, so
          it cannot claim support the application does not have.
        </p>
      </Section>
      <FormatTable id="matrix" />
      <SupportLegend />

      <Section title="What this build deliberately does not do">
        <ul>
          <li>No accounts, no file history, no cloud storage — every visit is a guest session.</li>
          <li>No payments, subscriptions or premium tiers.</li>
          <li>
            No advertising. The layout reserves space for it so that enabling ads later cannot push
            content around, but nothing is loaded and no third-party script runs.
          </li>
          <li>No analytics or tracking of any kind.</li>
        </ul>
      </Section>

      <Section title="Your files">
        <p>
          Uploads are stored under generated names, never executed, and deleted automatically once
          their retention window passes. You can also delete a document immediately from the viewer.
          See the <Link href="/privacy">privacy page</Link> for the details.
        </p>
      </Section>
    </ProsePage>
  );
}
