import type { Metadata } from 'next';
import Link from 'next/link';
import { ProsePage, Section } from '@/components/site/ProsePage';
import { FormatTable, SupportLegend } from '@/components/site/Formats';
import { serverLang } from '@/lib/server-lang';

export async function generateMetadata(): Promise<Metadata> {
  const ru = (await serverLang()) === 'ru';
  return {
    title: ru ? 'О DocuView — как устроен просмотрщик' : 'About DocuView — how the viewer works',
    description: ru
      ? 'Как DocuView открывает CAD, PDF и Office: определение формата, этапы обработки, движки каждого просмотрщика и какие форматы поддерживаются сегодня.'
      : 'How DocuView opens CAD, PDF and Office documents: format detection, the processing pipeline, the engines behind each viewer, and exactly which formats are supported today.',
    alternates: { canonical: '/about' },
  };
}

export default async function AboutPage() {
  return (await serverLang()) === 'ru' ? <Russian /> : <English />;
}

function English() {
  return (
    <ProsePage
      title="About DocuView"
      subtitle="A browser viewer for engineering and office documents, built so that opening a file is the only thing you have to do."
    >
      <Section title="The idea">
        <p>
          Opening a CAD model usually means installing something. A colleague sends a SolidWorks
          assembly, a supplier sends a DXF, a customer sends a PPTX — and each one wants its own
          application. DocuView collapses that into a single step: drop the file, and the right viewer
          opens with the tools that format genuinely supports.
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
            <strong>SolidWorks</strong> — read without SOLIDWORKS: the display meshes and Parasolid
            bodies inside parts, the placements inside assemblies, the sheet graphics and view edges
            inside drawings.
          </li>
          <li>
            <strong>CAD and 3D</strong> — three.js for rendering. STEP, IGES and BREP files are
            tessellated server-side by OpenCascade (through <code>occt-import-js</code>), which keeps
            the assembly tree and B-Rep face structure intact. Mesh formats are parsed in the browser.
          </li>
          <li>
            <strong>PDF</strong> — PDF.js, rendering straight from the stored file; pdf-lib for edits.
          </li>
          <li>
            <strong>Word</strong> — mammoth converts DOCX to semantic HTML; edits are written into the
            original XML. LibreOffice provides the exact page layout on request and handles legacy formats.
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
            No advertising. The layout can reserve space for it, but nothing is loaded and no
            third-party script runs.
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

function Russian() {
  return (
    <ProsePage
      title="О DocuView"
      subtitle="Просмотрщик инженерных и офисных документов в браузере: чтобы открыть файл, достаточно его перетащить."
    >
      <Section title="Идея">
        <p>
          Чтобы открыть модель CAD, обычно нужно что-то установить. Коллега присылает сборку
          SolidWorks, поставщик — DXF, заказчик — PPTX, и каждому файлу нужна своя программа.
          DocuView сводит всё к одному шагу: перетащите файл — и откроется нужный просмотрщик с
          инструментами, которые этот формат действительно поддерживает.
        </p>
      </Section>

      <Section title="Как обрабатывается файл">
        <p>Каждая загрузка проходит пять этапов, и интерфейс называет каждый по ходу дела:</p>
        <ul>
          <li>
            <strong>Загрузка</strong> — браузер передаёт файл с настоящим прогрессом, отменить можно
            в любой момент.
          </li>
          <li>
            <strong>Определение формата</strong> — по содержимому файла, а не по имени.{' '}
            <code>.stl</code>, который на деле текстовый, откроется как текст, и об этом будет сказано.
          </li>
          <li>
            <strong>Обработка</strong> — форматы, которым нужен серверный модуль, обрабатываются в
            отдельном процессе. Сбой разбора там не уронит саму службу.
          </li>
          <li>
            <strong>Подготовка геометрии</strong> — модели CAD переводятся в компактный двоичный
            формат, который браузер сразу передаёт в WebGL.
          </li>
          <li>
            <strong>Загрузка просмотрщика</strong> — тяжёлые библиотеки 3D и PDF скачиваются, только
            когда они действительно нужны файлу.
          </li>
        </ul>
      </Section>

      <Section title="На чём построены просмотрщики">
        <ul>
          <li>
            <strong>SolidWorks</strong> — читается без SOLIDWORKS: сетки отображения и тела Parasolid
            внутри деталей, положения деталей внутри сборок, графика листов и рёбра видов внутри
            чертежей.
          </li>
          <li>
            <strong>CAD и 3D</strong> — отрисовка через three.js. STEP, IGES и BREP разбиваются на
            треугольники на сервере через OpenCascade (<code>occt-import-js</code>) с сохранением
            дерева сборки и граней B-Rep. Сеточные форматы разбираются прямо в браузере.
          </li>
          <li>
            <strong>PDF</strong> — PDF.js рисует прямо из сохранённого файла; правки — через pdf-lib.
          </li>
          <li>
            <strong>Word</strong> — mammoth переводит DOCX в HTML; правки записываются в исходный XML.
            LibreOffice по запросу даёт точную разметку страниц и открывает старые форматы.
          </li>
          <li>
            <strong>Excel</strong> — ExcelJS читает книгу в таблицу со стилями, объединениями и
            форматами чисел.
          </li>
          <li>
            <strong>PowerPoint</strong> — слайды рисует LibreOffice Impress; структура и заметки
            докладчика читаются прямо из OOXML.
          </li>
        </ul>
      </Section>

      <Section title="Что поддерживается сегодня">
        <p>
          Таблица ниже строится из того же реестра, по которому сервер направляет загрузки, поэтому
          она не может обещать того, чего программа не умеет.
        </p>
      </Section>
      <FormatTable id="matrix" />
      <SupportLegend />

      <Section title="Чего эта версия намеренно не делает">
        <ul>
          <li>Нет учётных записей, истории файлов и облачного хранилища — каждый визит гостевой.</li>
          <li>Нет платежей, подписок и платных тарифов.</li>
          <li>Нет рекламы: место под неё может быть зарезервировано, но ничего не загружается и сторонние скрипты не запускаются.</li>
          <li>Нет аналитики и слежки.</li>
        </ul>
      </Section>

      <Section title="Ваши файлы">
        <p>
          Загрузки хранятся под случайными именами, никогда не запускаются и удаляются автоматически
          по истечении срока хранения. Документ можно удалить и сразу, из просмотрщика. Подробности —
          на странице <Link href="/privacy">конфиденциальности</Link>.
        </p>
      </Section>
    </ProsePage>
  );
}
