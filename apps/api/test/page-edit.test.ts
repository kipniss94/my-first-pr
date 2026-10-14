import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import AdmZip from 'adm-zip';
import { PDFDocument } from 'pdf-lib';
import { deleteDocxPages, PageEditError } from '../src/processing/edit/docx-pages.js';
import { deletePdfPages } from '../src/processing/edit/pdf-pages.js';

/**
 * The Word engine is given the text of each rendered page — exactly what it
 * gets from the page view in production — so these tests fix the layout and
 * check the document that comes out.
 */

const PORTRAIT = '<w:sectPr><w:headerReference w:type="first" r:id="rId11"/><w:pgSz w:w="11906" w:h="16838"/><w:titlePg/></w:sectPr>';
const LANDSCAPE = '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr>';

const p = (text: string, extra = '') => `<w:p>${extra}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const holder = (sectPr: string) => `<w:p><w:pPr><w:rPr><w:sz w:val="2"/></w:rPr>${sectPr}</w:pPr></w:p>`;
const pageBreak = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>`;

function docx(body: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
  );
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`,
    ),
  );
  return zip.toBuffer();
}

function bodyOf(buffer: Buffer): string {
  const xml = new AdmZip(buffer).getEntry('word/document.xml')!.getData().toString('utf8');
  return xml.slice(xml.indexOf('<w:body>') + 8, xml.indexOf('</w:body>'));
}

describe('deleting Word pages', () => {
  it('removes a trailing section completely, keeping the first page’s own settings', () => {
    // The shape of the real file that prompted this: a letter, a section break,
    // and a landscape appendix page holding only its heading.
    const source = docx(
      p('Уважаемый Имя Отчество! Направляем Вам коммерческое предложение') +
        holder(PORTRAIT) +
        p('Приложение 1 – Расчет стоимости неисключительного права') +
        LANDSCAPE,
    );
    const pages = ['ОДО ИНТЕРМЕХ Уважаемый Имя Отчество! Направляем Вам коммерческое предложение', 'Приложение 1 – Расчет стоимости неисключительного права'];

    const body = bodyOf(deleteDocxPages(source, pages, [2]).docx);
    assert.ok(!body.includes('Приложение 1'), 'the appendix heading must be gone');
    assert.ok(!body.includes('landscape'), 'the landscape section must be gone with it');
    assert.equal((body.match(/<w:sectPr/g) ?? []).length, 1, 'one section left');
    assert.ok(body.endsWith(PORTRAIT), 'the letter keeps its first-page header and portrait size');
    assert.ok(body.includes('Направляем Вам'), 'the letter itself is untouched');
  });

  it('removes a page from the middle and leaves its neighbours alone', () => {
    const source = docx(pageBreak('First page text here') + pageBreak('Second page text here') + p('Third page text here') + PORTRAIT);
    const pages = ['First page text here', 'Second page text here', 'Third page text here'];
    const body = bodyOf(deleteDocxPages(source, pages, [2]).docx);
    assert.ok(body.includes('First page') && body.includes('Third page'));
    assert.ok(!body.includes('Second page'));
  });

  it('drops the page break that would otherwise leave a blank last page', () => {
    const source = docx(pageBreak('First page text here') + p('Second page text here') + PORTRAIT);
    const body = bodyOf(deleteDocxPages(source, ['First page text here', 'Second page text here'], [2]).docx);
    assert.ok(!body.includes('w:type="page"'), 'no page break left dangling at the end');
  });

  it('keeps a section’s settings when only its last paragraph goes', () => {
    // Section one spans pages 1–2 and ends with its settings paragraph on
    // page 2; deleting page 2 must not hand page 1 the next section's layout.
    const settings = `<w:p><w:pPr>${LANDSCAPE}</w:pPr><w:r><w:t>Closing words of section one</w:t></w:r></w:p>`;
    const source = docx(pageBreak('Opening words of section one') + settings + p('Section two content') + PORTRAIT);
    const pages = ['Opening words of section one', 'Closing words of section one', 'Section two content'];
    const body = bodyOf(deleteDocxPages(source, pages, [2]).docx);
    assert.ok(!body.includes('Closing words'));
    assert.ok(body.includes('landscape'), 'section one keeps its own settings');
  });

  it('keeps a paragraph whole when it runs onto a page that stays', () => {
    const long = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma';
    const source = docx(p(long) + p('Something on page two only') + PORTRAIT);
    const pages = ['Alpha beta gamma delta epsilon zeta eta theta', 'iota kappa lambda mu nu xi omicron pi rho sigma Something on page two only'];
    const edit = deleteDocxPages(source, pages, [1]);
    assert.equal(edit.keptPartial, 1);
    assert.ok(bodyOf(edit.docx).includes('Alpha beta'), 'the straddling paragraph is kept, not cut');
  });

  it('refuses to delete every page, and pages that do not exist', () => {
    const source = docx(p('Only page text') + PORTRAIT);
    assert.throws(() => deleteDocxPages(source, ['Only page text'], [1]), PageEditError);
    assert.throws(() => deleteDocxPages(source, ['Only page text'], [7]), PageEditError);
  });
});

describe('deleting PDF pages', () => {
  it('removes exactly the requested pages', async () => {
    const pdf = await PDFDocument.create();
    for (const width of [100, 200, 300]) pdf.addPage([width, 100]);
    const edited = await deletePdfPages(await pdf.save(), [2]);
    const result = await PDFDocument.load(edited.pdf);
    assert.deepEqual(result.getPages().map((page) => page.getWidth()), [100, 300]);
  });

  it('refuses to delete every page', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    await assert.rejects(deletePdfPages(await pdf.save(), [1]), PageEditError);
  });
});
