import type { Metadata } from 'next';
import { PlaceholderNotice, ProsePage, Section } from '@/components/site/ProsePage';

export const metadata: Metadata = {
  title: 'Terms',
  description: 'Terms of use for the DocuView document viewer preview.',
  alternates: { canonical: '/terms' },
};

export default function TermsPage() {
  return (
    <ProsePage
      title="Terms of use"
      subtitle="Plain terms for a preview build of a document viewer."
      updated="stage 1 preview"
    >
      <PlaceholderNotice />

      <Section title="What this service is">
        <p>
          DocuView displays documents you upload. It is a viewer: it does not edit, sign, certify or
          archive anything. Nothing here is a system of record.
        </p>
      </Section>

      <Section title="What you may upload">
        <p>
          Only files you have the right to open and process. Do not upload material that is illegal
          where you are, that you do not own or have permission to use, or that contains personal
          data you are not allowed to share.
        </p>
      </Section>

      <Section title="Accuracy">
        <p>
          Measurements and derived properties are computed on tessellated geometry and inherit its
          tolerance. Converted documents are a rendering of the original, not the original. Do not
          rely on this viewer for manufacturing decisions, compliance checks or anything where being
          wrong is expensive — verify against the source file in the software that produced it.
        </p>
      </Section>

      <Section title="Availability">
        <p>
          This is a preview build offered as-is, without warranty of any kind. It may be
          unavailable, may lose data, and may change without notice. Uploaded files are deleted
          automatically, so keep your own copy.
        </p>
      </Section>

      <Section title="Limits">
        <p>
          Upload size, retention period and request rates are limited to keep the service usable for
          everyone. Automated or abusive use may be blocked.
        </p>
      </Section>

      <Section title="Liability">
        <p>
          To the extent permitted by law, the operator of this instance is not liable for any loss
          arising from use of the service, including loss of data or decisions made on the basis of
          what the viewer displayed.
        </p>
      </Section>
    </ProsePage>
  );
}
