import type { Metadata } from 'next';
import { PlaceholderNotice, ProsePage, Section } from '@/components/site/ProsePage';
import { serverLang } from '@/lib/server-lang';

export async function generateMetadata(): Promise<Metadata> {
  const ru = (await serverLang()) === 'ru';
  return {
    title: ru ? 'Конфиденциальность' : 'Privacy',
    description: ru
      ? 'Что происходит с файлами, открытыми в DocuView: временное хранение, автоматическое удаление, без регистрации и слежки.'
      : 'What happens to files you open with DocuView: temporary storage, automatic deletion, no accounts and no tracking.',
    alternates: { canonical: '/privacy' },
  };
}

export default async function PrivacyPage() {
  return (await serverLang()) === 'ru' ? <Russian /> : <English />;
}

function English() {
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

      <Section title="Edited copies">
        <p>
          When you edit a document and save it, the edited copy is made for you and handed straight to
          your browser to save on your computer. It is not kept on the server, and the uploaded
          original is never changed.
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

      <Section title="Your browser">
        <p>
          Two cookies remember the interface language and the colour theme you chose; the viewer also
          keeps small preferences and the documents you opened in your browser&apos;s own storage.
          None of it leaves your device or is used to identify you.
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

function Russian() {
  return (
    <ProsePage
      title="Конфиденциальность"
      subtitle="Что происходит с открытым здесь файлом — так, как на самом деле работает программа."
      updated="предварительная версия"
    >
      <PlaceholderNotice />

      <Section title="Что мы храним">
        <p>
          Когда вы открываете документ, файл записывается на сервер, чтобы просмотрщик мог его
          прочитать. Он хранится под случайным именем; исходное имя файла остаётся только подписью,
          которую видите вы. Рядом хранятся размер файла, определённый формат и время загрузки.
        </p>
      </Section>

      <Section title="Сколько храним">
        <p>
          Загруженные файлы удаляются автоматически по истечении срока хранения — точный срок
          указан под полем загрузки. Фоновая очистка удаляет просроченные файлы, даже если служба
          перезапускалась. Документ можно удалить и сразу — кнопкой удаления в просмотрщике: она
          удаляет исходный файл и всё, что из него получено.
        </p>
      </Section>

      <Section title="Отредактированные копии">
        <p>
          Когда вы редактируете документ и сохраняете его, копия с изменениями создаётся для вас и
          сразу передаётся браузеру, чтобы сохранить на компьютер. На сервере она не остаётся, а
          загруженный исходный файл никогда не меняется.
        </p>
      </Section>

      <Section title="Чего мы не делаем">
        <ul>
          <li>Не требуем регистрации и не спрашиваем адрес почты.</li>
          <li>Не ведём аналитику и не ставим следящих cookie.</li>
          <li>Не загружаем стороннюю рекламу в этой версии.</li>
          <li>Никогда не запускаем загруженные файлы: макросы, скрипты и встроенный код не выполняются.</li>
          <li>Ни с кем не делимся загруженными документами.</li>
        </ul>
      </Section>

      <Section title="Обработка на сервере">
        <p>
          Некоторые форматы нужно подготовить, прежде чем браузер сможет их показать: STEP и IGES
          разбиваются на треугольники, старые форматы Office преобразуются. Это делает отдельный
          процесс на том же сервере — только с загруженным вами файлом. Полученные данные лежат в той
          же папке, что и исходный файл, и удаляются вместе с ним.
        </p>
      </Section>

      <Section title="Журналы">
        <p>
          Служба пишет технические журналы — время, размеры файлов, определённые форматы и
          подробности ошибок, — чтобы разбираться в сбоях. Содержимое документов в журналы не
          попадает. Сообщения об ошибках в браузере намеренно без технических деталей: подробности
          остаются в журнале.
        </p>
      </Section>

      <Section title="Ваш браузер">
        <p>
          Две cookie помнят выбранные язык интерфейса и цветовую тему; ещё просмотрщик хранит в
          памяти браузера мелкие настройки и открытые документы. Ничто из этого не покидает ваше
          устройство и не используется, чтобы вас опознать.
        </p>
      </Section>

      <Section title="Связь">
        <p>
          Это предварительная версия, которую каждый запускает у себя. По вопросам конфиденциальности
          обращайтесь к тому, кто обслуживает этот экземпляр.
        </p>
      </Section>
    </ProsePage>
  );
}
