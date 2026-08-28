/**
 * Generate the test documents used to verify every viewer.
 *
 * Everything here is produced locally so the checks are reproducible and the
 * repository carries no third-party sample files. Office fixtures are written
 * as flat ODF and handed to LibreOffice, which yields genuine DOCX/PPTX files
 * with real themes rather than hand-rolled minimal ZIPs.
 *
 *   node scripts/make-fixtures.mjs [outDir]
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StepBuilder, boxFaces, hollowBoxFaces } from './step-builder.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(root, process.argv[2] ?? 'fixtures');

const SOFFICE = [
  process.env.LIBREOFFICE_BIN,
  '/usr/bin/soffice',
  '/usr/local/bin/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
].find((candidate) => candidate && existsSync(candidate));

/* ---------------------------------- STEP ---------------------------------- */

async function writeStep() {
  const cube = new StepBuilder().build([{ name: 'Cube', faces: boxFaces([0, 0, 0], [40, 40, 40]) }], 'Cube 40mm');
  await write('cube.step', cube);

  const hollow = new StepBuilder().build(
    [{ name: 'HollowBlock', faces: hollowBoxFaces([0, 0, 0], [60, 40, 20], { min: [20, 14], max: [40, 26] }) }],
    'Hollow block',
  );
  await write('hollow-block.step', hollow);

  // A real assembly structure, so component names survive the round trip.
  const assembly = new StepBuilder().buildAssembly(
    [
      { name: 'BasePlate', faces: boxFaces([0, 0, 0], [80, 60, 8], 'base-') },
      { name: 'Riser', faces: boxFaces([20, 20, 8], [60, 40, 45], 'riser-') },
    ],
    'Bracket assembly',
  );
  await write('bracket-assembly.step', assembly);

  // Valid header, unreadable body: the app must fail politely, not crash.
  await write(
    'broken.step',
    ['ISO-10303-21;', 'HEADER;', "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));", 'ENDSEC;', 'DATA;', '#1 = NONSENSE(', ''].join('\n'),
  );
}

/* ----------------------------------- STL ---------------------------------- */

function stlTrianglesForBox(min, max) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = (x, y, z) => [x, y, z];
  const quad = (normal, a, b, c, d) => [
    [normal, a, b, c],
    [normal, a, c, d],
  ];
  return [
    ...quad([0, 0, -1], v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0)),
    ...quad([0, 0, 1], v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)),
    ...quad([0, -1, 0], v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)),
    ...quad([0, 1, 0], v(x1, y1, z0), v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1)),
    ...quad([-1, 0, 0], v(x0, y1, z0), v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1)),
    ...quad([1, 0, 0], v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)),
  ];
}

async function writeStl() {
  const triangles = [
    ...stlTrianglesForBox([0, 0, 0], [50, 30, 10]),
    ...stlTrianglesForBox([10, 8, 10], [40, 22, 35]),
  ];
  const buffer = Buffer.alloc(84 + triangles.length * 50);
  buffer.write('DocuView binary STL fixture', 0, 'ascii');
  buffer.writeUInt32LE(triangles.length, 80);
  let offset = 84;
  for (const [normal, a, b, c] of triangles) {
    for (const vector of [normal, a, b, c]) {
      for (const component of vector) {
        buffer.writeFloatLE(component, offset);
        offset += 4;
      }
    }
    buffer.writeUInt16LE(0, offset);
    offset += 2;
  }
  await write('stepped-block.stl', buffer);

  const ascii = ['solid pyramid'];
  for (const [normal, a, b, c] of stlTrianglesForBox([0, 0, 0], [20, 20, 20])) {
    ascii.push(`  facet normal ${normal.join(' ')}`);
    ascii.push('    outer loop');
    for (const vertex of [a, b, c]) ascii.push(`      vertex ${vertex.join(' ')}`);
    ascii.push('    endloop');
    ascii.push('  endfacet');
  }
  ascii.push('endsolid pyramid', '');
  await write('cube-ascii.stl', ascii.join('\n'));
}

/* ----------------------------------- OBJ ---------------------------------- */

async function writeObj() {
  const lines = ['# DocuView fixture: two named groups', ''];
  const emitBox = (name, min, max, base) => {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    lines.push(`g ${name}`, `o ${name}`);
    const corners = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    for (const [x, y, z] of corners) lines.push(`v ${x} ${y} ${z}`);
    const faces = [
      [1, 4, 3, 2], [5, 6, 7, 8], [1, 2, 6, 5],
      [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8],
    ];
    for (const face of faces) lines.push(`f ${face.map((i) => i + base).join(' ')}`);
    lines.push('');
    return base + 8;
  };
  let base = 0;
  base = emitBox('Base', [0, 0, 0], [40, 40, 6], base);
  emitBox('Column', [12, 12, 6], [28, 28, 40], base);
  await write('two-part.obj', lines.join('\n'));
}

/* ----------------------------------- DXF ---------------------------------- */

async function writeDxf() {
  const out = [];
  const pair = (code, value) => out.push(String(code), String(value));

  pair(0, 'SECTION');
  pair(2, 'HEADER');
  pair(9, '$ACADVER');
  pair(1, 'AC1015');
  pair(9, '$INSUNITS');
  pair(70, 4);
  pair(0, 'ENDSEC');

  pair(0, 'SECTION');
  pair(2, 'ENTITIES');

  const line = (x1, y1, x2, y2, layer = '0') => {
    pair(0, 'LINE');
    pair(8, layer);
    pair(10, x1); pair(20, y1); pair(30, 0);
    pair(11, x2); pair(21, y2); pair(31, 0);
  };

  // Outline of a 120 x 80 plate.
  line(0, 0, 120, 0, 'OUTLINE');
  line(120, 0, 120, 80, 'OUTLINE');
  line(120, 80, 0, 80, 'OUTLINE');
  line(0, 80, 0, 0, 'OUTLINE');

  for (const [cx, cy] of [[15, 15], [105, 15], [15, 65], [105, 65]]) {
    pair(0, 'CIRCLE');
    pair(8, 'HOLES');
    pair(10, cx); pair(20, cy); pair(30, 0);
    pair(40, 6);
  }

  pair(0, 'ARC');
  pair(8, 'OUTLINE');
  pair(10, 60); pair(20, 40); pair(30, 0);
  pair(40, 22);
  pair(50, 0);
  pair(51, 180);

  pair(0, 'LWPOLYLINE');
  pair(8, 'PROFILE');
  pair(90, 5);
  pair(70, 0);
  for (const [x, y] of [[30, 30], [50, 30], [60, 50], [40, 60], [30, 45]]) {
    pair(10, x); pair(20, y);
  }

  pair(0, 'TEXT');
  pair(8, 'NOTES');
  pair(10, 10); pair(20, 88); pair(30, 0);
  pair(40, 5);
  pair(1, 'DOCUVIEW DXF FIXTURE');

  pair(0, 'ENDSEC');
  pair(0, 'EOF');
  await write('plate.dxf', `${out.join('\n')}\n`);
}

/* ----------------------------------- PDF ---------------------------------- */

async function writePdf() {
  const pageText = (title, body) =>
    [
      'BT',
      '/F1 24 Tf',
      '72 760 Td',
      `(${title}) Tj`,
      '/F1 12 Tf',
      '0 -36 Td',
      ...body.map((line) => `(${line.replace(/([()\\])/g, '\\$1')}) Tj 0 -18 Td`),
      'ET',
    ].join('\n');

  const contents = [
    pageText('DocuView PDF fixture', [
      'Page one of two.',
      'This file is generated by scripts/make-fixtures.mjs.',
      'Use it to check rendering, zoom, navigation and text search.',
      'Searchable keyword: hydraulic manifold.',
    ]),
    pageText('Second page', [
      'Page two of two.',
      'Another searchable keyword: tolerance stack.',
      'The thumbnail rail should show two pages.',
    ]),
  ];

  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>';
  objects[4] = `<< /Length ${Buffer.byteLength(contents[0])} >>\nstream\n${contents[0]}\nendstream`;
  objects[5] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>';
  objects[6] = `<< /Length ${Buffer.byteLength(contents[1])} >>\nstream\n${contents[1]}\nendstream`;
  objects[7] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = Buffer.byteLength(pdf);
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  await write('report.pdf', pdf);
}

/* --------------------------------- Office --------------------------------- */

const FODT = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
 <office:body>
  <office:text>
   <text:h text:outline-level="1">Assembly inspection report</text:h>
   <text:p>This DOCX fixture is generated from flat ODF by LibreOffice.</text:p>
   <text:h text:outline-level="2">Scope</text:h>
   <text:p>The report covers dimensional checks on the hydraulic manifold block.</text:p>
   <text:list>
    <text:list-item><text:p>Bore diameter within tolerance.</text:p></text:list-item>
    <text:list-item><text:p>Face flatness within 0.05 mm.</text:p></text:list-item>
    <text:list-item><text:p>Surface finish Ra 1.6.</text:p></text:list-item>
   </text:list>
   <text:h text:outline-level="2">Measurements</text:h>
   <table:table table:name="Measurements">
    <table:table-column table:number-columns-repeated="3"/>
    <table:table-row>
     <table:table-cell><text:p>Feature</text:p></table:table-cell>
     <table:table-cell><text:p>Nominal</text:p></table:table-cell>
     <table:table-cell><text:p>Measured</text:p></table:table-cell>
    </table:table-row>
    <table:table-row>
     <table:table-cell><text:p>Bore A</text:p></table:table-cell>
     <table:table-cell><text:p>20.00</text:p></table:table-cell>
     <table:table-cell><text:p>20.02</text:p></table:table-cell>
    </table:table-row>
    <table:table-row>
     <table:table-cell><text:p>Bore B</text:p></table:table-cell>
     <table:table-cell><text:p>12.00</text:p></table:table-cell>
     <table:table-cell><text:p>11.98</text:p></table:table-cell>
    </table:table-row>
   </table:table>
   <text:p>End of report.</text:p>
  </office:text>
 </office:body>
</office:document>
`;

const FODP = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation">
 <office:automatic-styles>
  <style:style style:name="titleFrame" style:family="presentation"/>
 </office:automatic-styles>
 <office:body>
  <office:presentation>
   <draw:page draw:name="Overview">
    <draw:frame draw:layer="layout" svg:width="24cm" svg:height="3cm" svg:x="2cm" svg:y="2cm">
     <draw:text-box><text:p>DocuView presentation fixture</text:p></draw:text-box>
    </draw:frame>
    <draw:frame draw:layer="layout" svg:width="24cm" svg:height="6cm" svg:x="2cm" svg:y="6cm">
     <draw:text-box>
      <text:p>Slide one: overview of the viewer pipeline.</text:p>
      <text:p>Upload, detect, process, view.</text:p>
     </draw:text-box>
    </draw:frame>
    <presentation:notes>
     <draw:frame svg:width="20cm" svg:height="10cm" svg:x="2cm" svg:y="10cm">
      <draw:text-box><text:p>Speaker note for the first slide.</text:p></draw:text-box>
     </draw:frame>
    </presentation:notes>
   </draw:page>
   <draw:page draw:name="Formats">
    <draw:frame draw:layer="layout" svg:width="24cm" svg:height="3cm" svg:x="2cm" svg:y="2cm">
     <draw:text-box><text:p>Supported formats</text:p></draw:text-box>
    </draw:frame>
    <draw:frame draw:layer="layout" svg:width="24cm" svg:height="8cm" svg:x="2cm" svg:y="6cm">
     <draw:text-box>
      <text:p>STEP and IGES through OpenCascade.</text:p>
      <text:p>STL, OBJ, glTF in the browser.</text:p>
      <text:p>PDF through PDF.js.</text:p>
     </draw:text-box>
    </draw:frame>
   </draw:page>
   <draw:page draw:name="Summary">
    <draw:frame draw:layer="layout" svg:width="24cm" svg:height="3cm" svg:x="2cm" svg:y="2cm">
     <draw:text-box><text:p>Summary</text:p></draw:text-box>
    </draw:frame>
    <draw:frame draw:layer="layout" svg:width="24cm" svg:height="6cm" svg:x="2cm" svg:y="6cm">
     <draw:text-box><text:p>Three slides is enough to test navigation.</text:p></draw:text-box>
    </draw:frame>
   </draw:page>
  </office:presentation>
 </office:body>
</office:document>
`;

async function convert(sourceName, source, target, finalName) {
  if (!SOFFICE) {
    console.warn(`! LibreOffice not found, skipping ${finalName}`);
    return false;
  }
  const work = path.join(outDir, '.work');
  await fs.mkdir(work, { recursive: true });
  const sourcePath = path.join(work, sourceName);
  await fs.writeFile(sourcePath, source, 'utf8');
  await execFileAsync(
    SOFFICE,
    [
      `-env:UserInstallation=${pathToFileURL(path.join(work, 'profile')).href}`,
      '--headless',
      '--norestore',
      '--convert-to',
      target,
      '--outdir',
      work,
      sourcePath,
    ],
    { timeout: 180000 },
  );
  const produced = path.join(work, `${path.basename(sourceName, path.extname(sourceName))}.${target.split(':')[0]}`);
  await fs.copyFile(produced, path.join(outDir, finalName));
  console.log(`  ${finalName}`);
  return true;
}

async function writeOfficeFixtures() {
  await convert('inspection-report.fodt', FODT, 'docx', 'inspection-report.docx');
  await convert('pipeline-overview.fodp', FODP, 'pptx', 'pipeline-overview.pptx');

  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'DocuView fixtures';

  const parts = workbook.addWorksheet('Parts');
  parts.columns = [
    { header: 'Part', key: 'part', width: 26 },
    { header: 'Material', key: 'material', width: 18 },
    { header: 'Qty', key: 'qty', width: 8 },
    { header: 'Unit cost', key: 'cost', width: 14 },
    { header: 'Total', key: 'total', width: 14 },
  ];
  parts.getRow(1).font = { bold: true };
  parts.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  const rows = [
    ['Manifold block', 'Aluminium 6082', 4, 128.4],
    ['Cover plate', 'Steel S355', 8, 22.15],
    ['Seal kit', 'NBR', 16, 4.5],
    ['Fastener M8x40', 'A2-70', 64, 0.35],
  ];
  rows.forEach((row, index) => {
    const line = parts.addRow({ part: row[0], material: row[1], qty: row[2], cost: row[3] });
    line.getCell('cost').numFmt = '#,##0.00';
    line.getCell('total').value = { formula: `C${index + 2}*D${index + 2}`, result: row[2] * row[3] };
    line.getCell('total').numFmt = '#,##0.00';
  });
  parts.mergeCells('A7:B7');
  parts.getCell('A7').value = 'Order total';
  parts.getCell('A7').font = { bold: true };
  parts.getCell('E7').value = { formula: 'SUM(E2:E5)', result: rows.reduce((sum, r) => sum + r[2] * r[3], 0) };
  parts.getCell('E7').numFmt = '#,##0.00';
  parts.getCell('E7').font = { bold: true };

  const tolerances = workbook.addWorksheet('Tolerances');
  tolerances.addRow(['Feature', 'Nominal', 'Lower', 'Upper', 'Checked']);
  tolerances.getRow(1).font = { bold: true };
  tolerances.addRow(['Bore A', 20, -0.02, 0.03, true]);
  tolerances.addRow(['Bore B', 12, -0.02, 0.02, true]);
  tolerances.addRow(['Slot width', 8.5, -0.05, 0.05, false]);
  tolerances.getColumn(1).width = 18;

  await workbook.xlsx.writeFile(path.join(outDir, 'bill-of-materials.xlsx'));
  console.log('  bill-of-materials.xlsx');
}

/* ------------------------------- plain files ------------------------------ */

async function writeMisc() {
  await write(
    'measurements.csv',
    [
      'feature,nominal_mm,measured_mm,deviation_mm',
      'Bore A,20.00,20.02,0.02',
      'Bore B,12.00,11.98,-0.02',
      'Slot width,8.50,8.54,0.04',
      'Overall length,120.00,119.97,-0.03',
      '',
    ].join('\n'),
  );

  await write(
    'notes.txt',
    ['DocuView fixture notes', '', 'Plain text files open in the document viewer.', ''].join('\n'),
  );

  // Not a real model: verifies the "we could not recognise this file" path.
  await write('not-a-model.stl', 'This file claims to be an STL but is plain prose.\n');

  // Random bytes with no signature at all.
  const random = Buffer.alloc(4096);
  for (let i = 0; i < random.length; i += 1) random[i] = (i * 137 + 61) % 256;
  await write('garbage.bin', random);
}

/* ---------------------------------- main ---------------------------------- */

async function write(name, contents) {
  await fs.writeFile(path.join(outDir, name), contents);
  const size = typeof contents === 'string' ? Buffer.byteLength(contents) : contents.length;
  console.log(`  ${name} (${(size / 1024).toFixed(1)} KB)`);
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  console.log(`Writing fixtures to ${outDir}`);
  await writeStep();
  await writeStl();
  await writeObj();
  await writeDxf();
  await writePdf();
  await writeMisc();
  await writeOfficeFixtures();
  await fs.rm(path.join(outDir, '.work'), { recursive: true, force: true });
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
