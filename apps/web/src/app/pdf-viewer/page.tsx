import type { Metadata } from 'next';
import { LandingPage } from '@/components/site/LandingPage';
import { serverLang } from '@/lib/server-lang';

export async function generateMetadata(): Promise<Metadata> {
  const ru = (await serverLang()) === 'ru';
  return {
    title: ru ? 'Просмотр PDF онлайн — чтение, поиск, правка и печать' : 'Online PDF viewer — read, search, edit and print PDFs in the browser',
    description: ru
      ? 'Бесплатный просмотр PDF: миниатюры страниц, масштаб по ширине или странице, поиск по тексту, исправление текста и удаление страниц, печать — без установки.'
      : 'Free online PDF viewer. Open a PDF, browse page thumbnails, zoom to fit width or page, search the full text, fix text and delete pages, print or download — nothing to install.',
    keywords: ['PDF viewer online', 'open PDF in browser', 'read PDF online', 'PDF reader', 'search PDF text', 'delete PDF pages'],
    alternates: { canonical: '/pdf-viewer' },
    openGraph: {
      title: ru ? 'Просмотр PDF онлайн' : 'Online PDF viewer',
      description: ru ? 'Открыть, найти, исправить и напечатать PDF в браузере.' : 'Open, search, edit and print PDF files in the browser.',
      url: '/pdf-viewer',
    },
  };
}

export default async function PdfViewerLanding() {
  return (await serverLang()) === 'ru' ? <Russian /> : <English />;
}

function English() {
  return (
    <LandingPage
      eyebrow="PDF viewer"
      title="Read any PDF in the browser"
      intro="Drop a PDF and it renders immediately with PDF.js — the same engine Firefox ships. Pages stream in as you scroll, thumbnails let you jump anywhere, full-text search highlights every match, and a quick edit fixes a line of text or drops a page."
      kinds={['pdf']}
      capabilities={[
        { title: 'Continuous pages', body: 'Scroll through the document naturally; pages render as they come into view.' },
        { title: 'Thumbnail rail', body: 'A page overview you can collapse, with the current page always highlighted.' },
        { title: 'Zoom that makes sense', body: 'Fit width, fit page, or step through fixed zoom levels.' },
        { title: 'Full-text search', body: 'Find text across every page, step between matches, and see how many there are.' },
        { title: 'Quick edits', body: 'Click a line of text to change it, delete pages from the thumbnail rail, and save the edited copy to your computer.' },
        { title: 'Print and download', body: 'Send the original file to your printer or save it back to your device.' },
      ]}
      limitations={[
        'Encrypted PDFs that require a password cannot be opened; we say so rather than failing silently.',
        'Changed text is written over the old in Liberation Sans; the old text is covered, not removed, so search may still find it.',
        'Interactive form filling and digital signature validation are not supported.',
      ]}
      faq={[
        {
          question: 'Is the PDF uploaded anywhere?',
          answer:
            'The file is stored on the server for the session so the viewer can stream it, and is deleted automatically afterwards. Rendering and editing happen in your browser.',
        },
        {
          question: 'Can I search inside scanned documents?',
          answer: 'Only if the scan already contains a text layer (searchable PDF). Pages that are pure images have no text to search.',
        },
        {
          question: 'How large a PDF can I open?',
          answer: 'Up to the upload limit shown on the upload box. Large documents render page by page, so memory stays reasonable.',
        },
      ]}
    />
  );
}

function Russian() {
  return (
    <LandingPage
      eyebrow="Просмотр PDF"
      title="Любой PDF прямо в браузере"
      intro="Перетащите PDF — он сразу отрисуется через PDF.js, тот же движок, что в Firefox. Страницы подгружаются при прокрутке, по миниатюрам можно перейти куда угодно, поиск подсвечивает каждое совпадение, а быстрая правка исправит строку текста или уберёт страницу."
      kinds={['pdf']}
      capabilities={[
        { title: 'Страницы подряд', body: 'Документ листается естественно; страницы рисуются по мере появления на экране.' },
        { title: 'Миниатюры', body: 'Обзор страниц, который можно свернуть; текущая страница всегда выделена.' },
        { title: 'Удобный масштаб', body: 'По ширине, страница целиком или фиксированные шаги масштаба.' },
        { title: 'Поиск по тексту', body: 'Поиск по всем страницам, переход между совпадениями и их число.' },
        { title: 'Быстрая правка', body: 'Щёлкните строку текста, чтобы изменить её, удалите страницы на панели миниатюр и сохраните исправленную копию на компьютер.' },
        { title: 'Печать и загрузка', body: 'Отправьте исходный файл на печать или сохраните его обратно на устройство.' },
      ]}
      limitations={[
        'PDF, защищённые паролем, не открываются — мы скажем об этом прямо.',
        'Изменённый текст пишется поверх старого шрифтом Liberation Sans; старый закрывается, но не удаляется, поэтому поиск может его найти.',
        'Заполнение интерактивных форм и проверка электронных подписей не поддерживаются.',
      ]}
      faq={[
        {
          question: 'Загружается ли PDF куда-то?',
          answer:
            'Файл хранится на сервере на время сеанса, чтобы просмотрщик мог его читать, и затем удаляется автоматически. Отрисовка и правка происходят в вашем браузере.',
        },
        {
          question: 'Можно ли искать в отсканированных документах?',
          answer: 'Только если в скане уже есть текстовый слой (PDF с поиском). На страницах-картинках искать нечего.',
        },
        {
          question: 'Насколько большой PDF можно открыть?',
          answer: 'До предела загрузки, указанного под полем загрузки. Большие документы рисуются постранично, поэтому памяти хватает.',
        },
      ]}
    />
  );
}
