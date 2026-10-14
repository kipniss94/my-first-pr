import type { Metadata } from 'next';
import { LandingPage } from '@/components/site/LandingPage';
import { serverLang } from '@/lib/server-lang';

export async function generateMetadata(): Promise<Metadata> {
  const ru = (await serverLang()) === 'ru';
  return {
    title: ru ? 'Просмотр Office онлайн — DOCX, XLSX и PPTX без Office' : 'Online Office viewer — open and edit DOCX, XLSX and PPTX without Office',
    description: ru
      ? 'Бесплатный просмотр и правка Word, Excel и PowerPoint в браузере: форматирование, таблицы и картинки сохраняются.'
      : 'Free online viewer for Word, Excel and PowerPoint files. Open and edit DOCX, XLSX and PPTX in the browser with formatting, tables and images intact.',
    keywords: [
      'online Word viewer',
      'DOCX viewer online',
      'Excel viewer online',
      'XLSX viewer',
      'PowerPoint viewer online',
      'PPTX viewer',
      'edit Office files in browser',
    ],
    alternates: { canonical: '/office-viewer' },
    openGraph: {
      title: ru ? 'Просмотр Office онлайн — DOCX, XLSX, PPTX' : 'Online Office viewer — DOCX, XLSX, PPTX',
      description: ru ? 'Word, Excel и PowerPoint в браузере.' : 'Open and edit Word, Excel and PowerPoint files in the browser.',
      url: '/office-viewer',
    },
  };
}

export default async function OfficeViewerLanding() {
  return (await serverLang()) === 'ru' ? <Russian /> : <English />;
}

function English() {
  return (
    <LandingPage
      eyebrow="Office viewer"
      title="Word, Excel and PowerPoint without installing Office"
      intro="Word documents open as clean, selectable text with their headings, lists, tables and images. Workbooks open as a real grid with every sheet, merged cells and number formats. Presentations show slide by slide. And each can be edited and saved back as the same kind of file, its formatting intact."
      kinds={['office']}
      capabilities={[
        { title: 'Documents stay readable', body: 'Headings, lists, tables and inline images survive the conversion, and the text remains selectable.' },
        { title: 'Edit and save', body: 'Change text, cells and slides; delete pages, sheets and slides; save to your computer as .docx, .xlsx or .pptx with everything else untouched.' },
        { title: 'Every sheet', body: 'Switch between worksheets and read merged cells as they were laid out.' },
        { title: 'Number formats', body: 'Currency, percentages, dates and decimals are formatted the way the workbook defined them.' },
        { title: 'Slide navigation', body: 'A slide rail with titles, plus speaker notes read straight from the presentation file.' },
        { title: 'Nothing is executed', body: 'Macros are never run. A macro-enabled workbook opens as data, and only as data.' },
      ]}
      limitations={[
        'Legacy DOC, XLS, PPT and OpenDocument files need LibreOffice installed on the server, and are edited only after saving them as DOCX, XLSX or PPTX.',
        'Charts and pivot tables inside spreadsheets are not drawn; their underlying cells are shown.',
        'Complex Word layouts (text boxes, multi-column sections, headers and footers) are simplified in the reading view.',
        'Spreadsheet formulas are shown as their last calculated value; a value typed over a formula replaces it.',
      ]}
      faq={[
        { question: 'Do I need Microsoft Office?', answer: 'No. Files are read on the server and shown as web content in your browser.' },
        {
          question: 'Are macros a risk?',
          answer: 'No. Uploaded files are never executed. Macro-enabled workbooks are parsed for their data only, and the macro code is ignored.',
        },
        {
          question: 'Can I edit the document?',
          answer:
            'Yes: text, cells and slide text, and whole pages, sheets or slides can be deleted. The edited copy is saved to your computer; the uploaded original is never changed.',
        },
      ]}
    />
  );
}

function Russian() {
  return (
    <LandingPage
      eyebrow="Просмотр Office"
      title="Word, Excel и PowerPoint без установки Office"
      intro="Документы Word открываются чистым текстом, который можно выделять, — с заголовками, списками, таблицами и картинками. Книги Excel — настоящей таблицей со всеми листами, объединёнными ячейками и форматами чисел. Презентации — слайд за слайдом. И любой из них можно отредактировать и сохранить в том же формате, не потеряв оформления."
      kinds={['office']}
      capabilities={[
        { title: 'Документы остаются читаемыми', body: 'Заголовки, списки, таблицы и встроенные картинки сохраняются, текст можно выделять.' },
        { title: 'Правка и сохранение', body: 'Меняйте текст, ячейки и слайды, удаляйте страницы, листы и слайды и сохраняйте на компьютер в .docx, .xlsx или .pptx — всё остальное остаётся как было.' },
        { title: 'Все листы', body: 'Переключайтесь между листами; объединённые ячейки выглядят как в оригинале.' },
        { title: 'Форматы чисел', body: 'Валюты, проценты, даты и дроби отображаются так, как задано в книге.' },
        { title: 'Навигация по слайдам', body: 'Список слайдов с заголовками и заметки докладчика прямо из файла презентации.' },
        { title: 'Ничего не запускается', body: 'Макросы никогда не выполняются. Книга с макросами открывается только как данные.' },
      ]}
      limitations={[
        'Старые DOC, XLS, PPT и OpenDocument требуют LibreOffice на сервере, а редактируются только после сохранения в DOCX, XLSX или PPTX.',
        'Диаграммы и сводные таблицы в книгах не рисуются — показываются ячейки, на которых они построены.',
        'Сложная вёрстка Word (надписи, колонки, колонтитулы) в режиме чтения упрощается.',
        'Формулы показываются последним вычисленным значением; введённое поверх формулы значение заменяет её.',
      ]}
      faq={[
        { question: 'Нужен ли Microsoft Office?', answer: 'Нет. Файлы читаются на сервере и показываются как веб-страница в вашем браузере.' },
        {
          question: 'Опасны ли макросы?',
          answer: 'Нет. Загруженные файлы никогда не запускаются. Из книг с макросами читаются только данные, код макросов игнорируется.',
        },
        {
          question: 'Можно ли редактировать документ?',
          answer:
            'Да: текст, ячейки и текст слайдов, а также удалять целые страницы, листы и слайды. Исправленная копия сохраняется на ваш компьютер; загруженный оригинал не меняется.',
        },
      ]}
    />
  );
}
