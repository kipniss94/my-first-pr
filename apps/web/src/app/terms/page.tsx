import type { Metadata } from 'next';
import { PlaceholderNotice, ProsePage, Section } from '@/components/site/ProsePage';
import { serverLang } from '@/lib/server-lang';

export async function generateMetadata(): Promise<Metadata> {
  const ru = (await serverLang()) === 'ru';
  return {
    title: ru ? 'Условия' : 'Terms',
    description: ru ? 'Условия использования предварительной версии DocuView.' : 'Terms of use for the DocuView document viewer preview.',
    alternates: { canonical: '/terms' },
  };
}

export default async function TermsPage() {
  return (await serverLang()) === 'ru' ? <Russian /> : <English />;
}

function English() {
  return (
    <ProsePage title="Terms of use" subtitle="Plain terms for a preview build of a document viewer." updated="stage 1 preview">
      <PlaceholderNotice />

      <Section title="What this service is">
        <p>
          DocuView displays documents you upload and can save edited copies of them to your computer.
          It does not sign, certify or archive anything, and it never changes the file you uploaded.
          Nothing here is a system of record.
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

function Russian() {
  return (
    <ProsePage
      title="Условия использования"
      subtitle="Простые условия для предварительной версии просмотрщика документов."
      updated="предварительная версия"
    >
      <PlaceholderNotice />

      <Section title="Что это за служба">
        <p>
          DocuView показывает загруженные вами документы и умеет сохранять их отредактированные копии
          на ваш компьютер. Он ничего не подписывает, не заверяет и не архивирует и никогда не меняет
          загруженный файл. Здесь нет ничего, что считалось бы официальным учётом.
        </p>
      </Section>

      <Section title="Что можно загружать">
        <p>
          Только файлы, которые вы вправе открывать и обрабатывать. Не загружайте то, что незаконно
          там, где вы находитесь, что вам не принадлежит или на что у вас нет разрешения, и
          персональные данные, которыми вы не вправе делиться.
        </p>
      </Section>

      <Section title="Точность">
        <p>
          Размеры и производные свойства считаются по геометрии из треугольников и наследуют её
          погрешность. Преобразованный документ — это отображение оригинала, а не сам оригинал. Не
          полагайтесь на этот просмотрщик в решениях о производстве, при проверках на соответствие и
          везде, где ошибка дорого стоит, — сверяйтесь с исходным файлом в программе, где он создан.
        </p>
      </Section>

      <Section title="Доступность">
        <p>
          Это предварительная версия «как есть», без каких-либо гарантий. Она может быть недоступна,
          терять данные и меняться без предупреждения. Загруженные файлы удаляются автоматически —
          храните свою копию.
        </p>
      </Section>

      <Section title="Ограничения">
        <p>
          Размер загрузки, срок хранения и частота запросов ограничены, чтобы служба оставалась
          удобной для всех. Автоматическое или злоупотребляющее использование может блокироваться.
        </p>
      </Section>

      <Section title="Ответственность">
        <p>
          В пределах, допускаемых законом, тот, кто обслуживает этот экземпляр, не отвечает за
          убытки от использования службы, в том числе за потерю данных и за решения, принятые на
          основе того, что показал просмотрщик.
        </p>
      </Section>
    </ProsePage>
  );
}
