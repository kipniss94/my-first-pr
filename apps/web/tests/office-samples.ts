import JSZip from 'jszip';

/**
 * Small Office files built in the test itself.
 *
 * The fixtures script makes its .docx and .pptx with LibreOffice and skips
 * them where it is missing; these minimal packages keep the browser-side Word
 * and PowerPoint renderers covered everywhere.
 */

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const CT = 'application/vnd.openxmlformats-officedocument';

async function pack(parts: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, xml] of Object.entries(parts)) zip.file(name, xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function rels(entries: Array<[id: string, type: string, target: string]>): string {
  return (
    `${XML}<Relationships xmlns="${PKG_RELS}">` +
    entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${OFFICE_RELS}/${type}" Target="${target}"/>`).join('') +
    '</Relationships>'
  );
}

/** A Word document of three A4 pages, each opening with its own heading. */
export function wordSample(): Promise<Buffer> {
  const paragraph = (text: string, style?: string) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  const body = [1, 2, 3]
    .map((page) => paragraph(`Chapter ${page}`, 'Heading1') + paragraph(`Text of page ${page}.`))
    .join(pageBreak);
  return pack({
    '[Content_Types].xml':
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/word/document.xml" ContentType="${CT}.wordprocessingml.document.main+xml"/>` +
      '</Types>',
    '_rels/.rels': rels([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/document.xml':
      `${XML}<w:document xmlns:w="${W}"><w:body>${body}` +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>' +
      '</w:body></w:document>',
  });
}

/** A PowerPoint deck of two 16:9 slides: a title and a coloured shape. */
export function slidesSample(): Promise<Buffer> {
  const colour = (name: string, rgb: string) => `<a:${name}><a:srgbClr val="${rgb}"/></a:${name}>`;
  const theme =
    `${XML}<a:theme xmlns:a="${A}" name="Sample"><a:themeElements>` +
    '<a:clrScheme name="Sample">' +
    colour('dk1', '000000') + colour('lt1', 'FFFFFF') + colour('dk2', '1F2937') + colour('lt2', 'E5E7EB') +
    colour('accent1', '2563EB') + colour('accent2', 'DC2626') + colour('accent3', '16A34A') +
    colour('accent4', 'CA8A04') + colour('accent5', '7C3AED') + colour('accent6', '0891B2') +
    colour('hlink', '2563EB') + colour('folHlink', '7C3AED') +
    '</a:clrScheme>' +
    '<a:fontScheme name="Sample"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
    '<a:fmtScheme name="Sample">' +
    '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
    '<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
    '</a:fmtScheme></a:themeElements></a:theme>';
  const emptyTree =
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  const textStyle = (size: number) => `<a:lvl1pPr><a:defRPr sz="${size}"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>`;
  const master =
    `${XML}<p:sldMaster xmlns:a="${A}" xmlns:r="${OFFICE_RELS}" xmlns:p="${P}">` +
    `<p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>${emptyTree}</p:spTree></p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    `<p:txStyles><p:titleStyle>${textStyle(4400)}</p:titleStyle><p:bodyStyle>${textStyle(2800)}</p:bodyStyle><p:otherStyle>${textStyle(1800)}</p:otherStyle></p:txStyles>` +
    '</p:sldMaster>';
  const layout =
    `${XML}<p:sldLayout xmlns:a="${A}" xmlns:r="${OFFICE_RELS}" xmlns:p="${P}" type="blank">` +
    `<p:cSld name="Blank">${emptyTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const shape = (id: number, name: string, x: number, y: number, cx: number, cy: number, fill: string | null, text: string) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `${fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : '<a:noFill/>'}</p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3200"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const slide = (shapes: string) =>
    `${XML}<p:sld xmlns:a="${A}" xmlns:r="${OFFICE_RELS}" xmlns:p="${P}"><p:cSld>${emptyTree}${shapes}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
  const slideRels = rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]);
  return pack({
    '[Content_Types].xml':
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentationml.presentation.main+xml"/>` +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.presentationml.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/slides/slide1.xml" ContentType="${CT}.presentationml.slide+xml"/>` +
      `<Override PartName="/ppt/slides/slide2.xml" ContentType="${CT}.presentationml.slide+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="${CT}.theme+xml"/>` +
      '</Types>',
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml':
      `${XML}<p:presentation xmlns:a="${A}" xmlns:r="${OFFICE_RELS}" xmlns:p="${P}">` +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      '<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst>' +
      '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>' +
      `<p:defaultTextStyle>${textStyle(1800)}</p:defaultTextStyle></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'slide', 'slides/slide1.xml'],
      ['rId3', 'slide', 'slides/slide2.xml'],
      ['rId4', 'theme', 'theme/theme1.xml'],
    ]),
    'ppt/slideMasters/slideMaster1.xml': master,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'theme', '../theme/theme1.xml'],
    ]),
    'ppt/slideLayouts/slideLayout1.xml': layout,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/theme/theme1.xml': theme,
    'ppt/slides/slide1.xml': slide(shape(2, 'Title', 838200, 2286000, 10515600, 1325563, null, 'Deck drawn in the browser')),
    'ppt/slides/_rels/slide1.xml.rels': slideRels,
    'ppt/slides/slide2.xml': slide(shape(2, 'Box', 1524000, 1524000, 9144000, 3810000, '2563EB', 'Second slide')),
    'ppt/slides/_rels/slide2.xml.rels': slideRels,
  });
}
