import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countDocxPages, deleteDocxPages, DocxPageError } from '@docuview/shared';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const doc = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`;
const p = (text: string, inner = '') => `<w:p>${inner}<w:r><w:t>${text}</w:t></w:r></w:p>`;
const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
const portrait = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';
const landscape = '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr>';
const styles = `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Chapter"><w:pPr><w:pageBreakBefore/></w:pPr></w:style></w:styles>`;

describe('Word page deletion', () => {
  it('counts pages the way the viewer splits them', () => {
    assert.equal(countDocxPages(doc(p('one') + pageBreak + p('two') + portrait), null), 2);
    // A styled chapter heading starts a page.
    const chapters = doc(p('intro') + p('Chapter 1', '<w:pPr><w:pStyle w:val="Chapter"/></w:pPr>') + portrait);
    assert.equal(countDocxPages(chapters, styles), 2);
    // A section of the same paper size does not start a new page; one of
    // another size ends the page after it (docx-preview's rule).
    assert.equal(countDocxPages(doc(`<w:p><w:pPr>${portrait}</w:pPr></w:p>` + p('same') + portrait), null), 1);
    const turned = `<w:p><w:pPr>${landscape}</w:pPr></w:p>` + p('upright') + `<w:p><w:pPr>${portrait}</w:pPr></w:p>` + p('next');
    assert.equal(countDocxPages(doc(turned + portrait), null), 2);
  });

  it('removes a page held by its own landscape section', () => {
    // The user's letter: page 2 is an empty landscape section. Deleting the
    // page has to take the section with it, or the sheet stays.
    // Word left a rendered page break in front of the appendix heading.
    const letter = doc(
      p('Dear colleagues') + `<w:p><w:pPr>${portrait}</w:pPr></w:p>` +
        '<w:p><w:r><w:lastRenderedPageBreak/><w:t>Appendix</w:t></w:r></w:p>' + landscape,
    );
    assert.equal(countDocxPages(letter, null), 2);
    const edit = deleteDocxPages(letter, null, [2]);
    assert.equal(edit.pagesAfter, 1);
    assert.equal(countDocxPages(edit.documentXml, null), 1);
    assert.match(edit.documentXml, /Dear colleagues/);
    assert.doesNotMatch(edit.documentXml, /landscape|Appendix/);
  });

  it('cuts a paragraph that runs across a page break', () => {
    const straddle = doc(
      p('first') + '<w:p><w:r><w:t>end of one</w:t></w:r><w:r><w:br w:type="page"/></w:r><w:r><w:t>start of two</w:t></w:r></w:p>' + portrait,
    );
    assert.equal(countDocxPages(straddle, null), 2);
    const edit = deleteDocxPages(straddle, null, [2]);
    assert.equal(countDocxPages(edit.documentXml, null), 1);
    assert.match(edit.documentXml, /end of one/);
    assert.doesNotMatch(edit.documentXml, /start of two/);
  });

  it('keeps the page after a deleted first page clean', () => {
    const three = doc(p('one') + pageBreak + p('two') + pageBreak + p('three') + portrait);
    const edit = deleteDocxPages(three, null, [1]);
    assert.equal(countDocxPages(edit.documentXml, null), 2);
    assert.doesNotMatch(edit.documentXml, />one</);
  });

  it('refuses to delete every page or a page that is not there', () => {
    const two = doc(p('one') + pageBreak + p('two') + portrait);
    assert.throws(() => deleteDocxPages(two, null, [1, 2]), DocxPageError);
    assert.throws(() => deleteDocxPages(two, null, [5]), DocxPageError);
  });
});
