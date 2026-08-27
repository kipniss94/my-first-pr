import type { Metadata } from 'next';
import { PlaceholderNotice, ProsePage, Section } from '@/components/site/ProsePage';

export const metadata: Metadata = {
  title: 'Privacy',
  description:
    'What happens to files you open with DocuView: temporary storage, automatic deletion, no accounts and no tracking.',
  alternates: { canonical: '/privacy' },
};

export default function PrivacyPage() {
  return (
    <ProsePage
      title="Privacy"
      subtitle="What happens to a file you open here, described as the software actually behaves."
      updated="stage 1 preview"
    >
      <PlaceholderNotice />

      <Section title="What we store">
        <p>
          When you open a document, the file is written to the server so the viewer can read it. It
          is stored under a randomly generated name; your original filename is kept only as a label
          shown back to you. Alongside it we keep the file size, the detected format and the time it
          was uploaded.
        </p>
      </Section>

      <Section title="How long we keep it">
        <p>
          Uploads are deleted automatically once their retention window passes — the exact period is
          shown under the upload box. A background sweeper removes expired files even if the service
          restarted in the meantime. You can also delete a document immediately with the delete
          button in the viewer, which removes the original and everything derived from it.
        </p>
      </Section>

      <Section title="What we do not do">
        <ul>
          <li>We do not require an account, and we do not ask for your email address.</li>
          <li>We do not run analytics, and we set no tracking cookies.</li>
          <li>We do not load third-party advertising in this build.</li>
          <li>We never execute an uploaded file. Macros, scripts and embedded code are never run.</li>
          <li>We do not share uploaded documents with anyone.</li>
        </ul>
      </Section>

      <Section title="Processing on the server">
        <p>
          Some formats have to be prepared before a browser can display them — STEP and IGES are
          tessellated, and legacy Office formats are converted. That work happens in an isolated
          process on the same server, on the file you uploaded and nothing else. Derived artifacts
          live in the same folder as the original and are deleted with it.
        </p>
      </Section>

      <Section title="Logs">
        <p>
          The service writes technical logs — timestamps, file sizes, detected formats and error
          details — to help diagnose failures. Logs never contain document contents. Error messages
          shown in your browser are deliberately non-technical; the detail stays in the log.
        </p>
      </Section>

      <Section title="Local storage in your browser">
        <p>
          The viewer remembers small interface preferences (such as panel widths) in your browser.
          That data never leaves your device and is not used to identify you.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          This is a self-hosted preview build. Whoever operates this instance is the point of
          contact for privacy questions.
        </p>
      </Section>
    </ProsePage>
  );
}
