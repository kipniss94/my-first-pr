import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import AdmZip from 'adm-zip';
import type { DocxEditable, PptxEditable, XlsxEditable } from '@docuview/shared';
import { applyEdits, readEditable } from '../src/processing/ooxml-edit.js';

/** A package from a map of part name → XML. */
function pack(parts: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, xml] of Object.entries(parts)) zip.addFile(name, Buffer.from(xml, 'utf8'));
  return zip.toBuffer();
}

function part(buffer: Buffer, name: string): string | null {
  return new AdmZip(buffer).getEntry(name)?.getData().toString('utf8') ?? null;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const docx = pack({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'word/document.xml':
    `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>` +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Заголовок</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p>' +
    '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' +
    '<w:p><w:r><w:t>Second page</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '<w:sectPr/></w:body></w:document>',
});

describe('editing Word documents', () => {
  it('reads paragraphs, tables, styles and pages', () => {
    const model = readEditable(docx, 'docx') as DocxEditable;
    assert.equal(model.kind, 'docx');
    assert.equal(model.pagesFrom, 'breaks');
    assert.equal(model.pages, 2);
    const [title, hello, , second, table] = model.blocks;
    assert.ok(title.type === 'paragraph' && title.paragraph.style === 'heading1' && title.paragraph.text === 'Заголовок');
    assert.ok(hello.type === 'paragraph' && hello.paragraph.text === 'Hello bold world' && hello.page === 1);
    assert.ok(second.type === 'paragraph' && second.page === 2);
    assert.ok(table.type === 'table' && table.rows[0][0][0].text === 'cell');
  });

  it('changes only the run that differs, and deletes blocks', () => {
    const edited = applyEdits(docx, 'docx', {
      docx: { paragraphs: [{ id: 1, text: 'Hello bright world' }, { id: 4, text: 'клетка' }], deleteBlocks: [3] },
    });
    const xml = part(edited, 'word/document.xml') ?? '';
    // The bold run holds the new word, the plain ones are untouched.
    assert.match(xml, /<w:rPr><w:b\/><\/w:rPr><w:t[^>]*>bright<\/w:t>/);
    assert.match(xml, /<w:t xml:space="preserve">Hello <\/w:t>/);
    assert.match(xml, /<w:t[^>]*> world<\/w:t>/);
    assert.match(xml, /клетка/);
    assert.doesNotMatch(xml, /Second page/);
    const model = readEditable(edited, 'docx') as DocxEditable;
    assert.ok(model.blocks.some((b) => b.type === 'paragraph' && b.paragraph.text === 'Hello bright world'));
  });
});

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const xlsx = pack({
  '[Content_Types].xml':
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="x"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="x"/></Types>',
  'xl/workbook.xml':
    `<?xml version="1.0"?><workbook ${S}><bookViews><workbookView activeTab="1"/></bookViews><sheets>` +
    '<sheet name="Данные" sheetId="1" r:id="rId1"/><sheet name="Итог" sheetId="2" r:id="rId2"/></sheets>' +
    '<definedNames><definedName name="x" localSheetId="1">Итог!$A$1</definedName></definedNames></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="t" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${S}><sheetData><row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>`,
  'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet ${S}><sheetData/></worksheet>`,
});

describe('editing Excel workbooks', () => {
  it('lists the sheets', () => {
    assert.deepEqual((readEditable(xlsx, 'xlsx') as XlsxEditable).sheets, ['Данные', 'Итог']);
  });

  it('writes typed values, numbers as numbers, and deletes a sheet with what pointed at it', () => {
    const edited = applyEdits(xlsx, 'xlsx', {
      xlsx: {
        cells: [
          { sheet: 'Данные', ref: 'A1', value: 'Привет' },
          { sheet: 'Данные', ref: 'C3', value: '42,5' },
          { sheet: 'Данные', ref: 'B3', value: '7' },
        ],
        deleteSheets: ['Итог'],
      },
    });
    const sheet = part(edited, 'xl/worksheets/sheet1.xml') ?? '';
    assert.match(sheet, /<c r="A1" t="inlineStr"><is><t xml:space="preserve">Привет<\/t><\/is><\/c>/);
    assert.doesNotMatch(sheet, /<f>/);
    // A new row 3, its cells in column order.
    assert.match(sheet, /<row r="3"><c r="B3"><v>7<\/v><\/c><c r="C3"><v>42.5<\/v><\/c><\/row>/);
    assert.equal(part(edited, 'xl/worksheets/sheet2.xml'), null);
    const workbook = part(edited, 'xl/workbook.xml') ?? '';
    assert.doesNotMatch(workbook, /Итог/);
    assert.match(workbook, /activeTab="0"/);
    assert.doesNotMatch(part(edited, 'xl/_rels/workbook.xml.rels') ?? '', /sheet2/);
    assert.doesNotMatch(part(edited, '[Content_Types].xml') ?? '', /sheet2/);
  });

  it('refuses to delete every sheet', () => {
    assert.throws(() => applyEdits(xlsx, 'xlsx', { xlsx: { deleteSheets: ['Данные', 'Итог'] } }));
  });
});

const PNS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const slide = (title: string, body: string) =>
  `<?xml version="1.0"?><p:sld ${PNS}><p:cSld><p:spTree>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:rPr lang="ru-RU"/><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>` +
  '</p:spTree></p:cSld></p:sld>';
const pptx = pack({
  '[Content_Types].xml':
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Override PartName="/ppt/slides/slide1.xml" ContentType="x"/><Override PartName="/ppt/slides/slide2.xml" ContentType="x"/></Types>',
  'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${PNS}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`,
  'ppt/_rels/presentation.xml.rels':
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId2" Type="t/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="t/slide" Target="slides/slide2.xml"/></Relationships>',
  'ppt/slides/slide1.xml': slide('Первый', 'Текст'),
  'ppt/slides/slide2.xml': slide('Второй', 'Ещё'),
});

describe('editing PowerPoint presentations', () => {
  it('reads each slide with its title and text shapes', () => {
    const model = readEditable(pptx, 'pptx') as PptxEditable;
    assert.equal(model.slides.length, 2);
    assert.equal(model.slides[0].title, 'Первый');
    assert.deepEqual(model.slides[1].shapes.map((s) => s.paragraphs), [['Второй'], ['Ещё', '']]);
  });

  it('changes text, fills an empty paragraph and deletes a slide', () => {
    const edited = applyEdits(pptx, 'pptx', {
      pptx: {
        texts: [
          { slide: 1, shape: '2', paragraph: 0, text: 'Второй слайд' },
          { slide: 1, shape: '3', paragraph: 1, text: 'Новая строка' },
        ],
        deleteSlides: [0],
      },
    });
    assert.equal(part(edited, 'ppt/slides/slide1.xml'), null);
    const second = part(edited, 'ppt/slides/slide2.xml') ?? '';
    assert.match(second, /<a:t>Второй слайд<\/a:t>/);
    assert.match(second, /<a:r><a:rPr lang="ru-RU"\/><a:t>Новая строка<\/a:t><\/a:r><a:endParaRPr\/>/);
    const model = readEditable(edited, 'pptx') as PptxEditable;
    assert.equal(model.slides.length, 1);
    assert.equal(model.slides[0].title, 'Второй слайд');
  });
});
