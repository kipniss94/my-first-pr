import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { breakLayout, readBreaks, readDrawing, sheetSvg } from '../src/processing/sldprt/drawing.js';

/**
 * The record grammar of a drawing's sheet graphics, on a stream built by hand
 * the way SolidWorks writes it: [u32 size][u32 kind] and then, tightly
 * packed, the record's fields; MFC Unicode strings as FF FE FF, length, UTF-16.
 */

const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};
const f64 = (...v: number[]) => {
  const b = Buffer.alloc(8 * v.length);
  v.forEach((x, k) => b.writeDoubleLE(x, k * 8));
  return b;
};
const f32 = (...v: number[]) => {
  const b = Buffer.alloc(4 * v.length);
  v.forEach((x, k) => b.writeFloatLE(x, k * 4));
  return b;
};
const text = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe, 0xff, s.length]), Buffer.from(s, 'utf16le')]);

const pen = (colorref: number) =>
  Buffer.concat([u32(0x4e), u32(0x0c), u32(colorref), Buffer.alloc(2), f32(-1), u32(3), u32(0), text('CONTINUOUS')]);
const segment = (x0: number, y0: number, x1: number, y1: number) =>
  Buffer.concat([u32(0x50), u32(4), f64(x0, y0, 0, x1, y1, 0), Buffer.alloc(1)]);
const circle = (cx: number, cy: number, r: number) =>
  Buffer.concat([u32(0x80), u32(2), f64(cx + r, cy, 0, cx + r, cy, 0, cx, cy, 0, 0, 0, 1)]);
const font = (height: number) =>
  Buffer.concat([u32(0x78), u32(0x0a), f64(height), u32(0), f64(0), f64(0.001), u32(1), text('GOST type A'), f64(1), f64(0)]);
const label = (x: number, y: number, s: string, advances: number[]) =>
  Buffer.concat([u32(0xc4), u32(0x12), f64(x, y, 0), u32(0), f64(0), u32(0), text(s), Buffer.from([1, 0]), u32(advances.length), f32(...advances)]);
const symbol = (x: number, y: number, height: number, library: string, name: string) =>
  Buffer.concat([u32(0x4a), u32(0x13), f64(x, y), Buffer.alloc(12), f64(0, height), text(library), text(name)]);
const sheet = (name: string, width: number, height: number) =>
  Buffer.concat([u32(0x38), u32(0x1e), Buffer.alloc(16), f64(1), u32(1), f64(height, width), text(name), Buffer.alloc(16)]);

describe('drawing sheets', () => {
  const stream = Buffer.concat([
    Buffer.alloc(32),
    pen(0x0000ff),
    segment(0.01, 0.02, 0.2, 0.02),
    circle(0.1, 0.1, 0.01),
    font(0.0035),
    label(0.05, 0.05, '110', [0.0015, 0.0015, 0.0022]),
    symbol(0.045, 0.05, 0.005, 'MOD', 'DIAM'),
    symbol(0.06, 0.06, 0.005, 'GWLD', 'FILLET'),
    sheet('Лист1-Active', 0.42, 0.297),
  ]);
  const drawing = readDrawing([{ name: 'Contents/DisplayLists', offset: 0, data: stream }]);

  it('reads the sheet, its lines, its circle, its text and its symbols', () => {
    assert.ok(drawing);
    assert.equal(drawing.sheets.length, 1);
    const [first] = drawing.sheets;
    assert.equal(first.name, 'Лист1');
    assert.equal(first.active, true);
    assert.deepEqual([first.width, first.height], [0.42, 0.297]);

    const paths = first.shapes.filter((s) => s.kind === 'path');
    assert.equal(paths.length, 2);
    // COLORREF 0x0000ff is red.
    assert.equal(paths[0].kind === 'path' && paths[0].pen.color, 0xff0000);
    assert.deepEqual(paths[0].kind === 'path' && paths[0].points, [
      [0.01, 0.02],
      [0.2, 0.02],
    ]);
    const round = paths[1];
    assert.ok(round.kind === 'path' && round.circle);
    assert.ok(Math.abs(round.circle.radius - 0.01) < 1e-12);

    const texts = first.shapes.filter((s) => s.kind === 'text');
    // The weld symbol has no character and is left out.
    assert.equal(texts.length, 2);
    const t = texts[0];
    assert.ok(t.kind === 'text');
    assert.equal(t.text, '110');
    assert.equal(t.height, 0.0035);
    assert.deepEqual(t.advances?.map((a) => Math.round(a * 1e4)), [15, 15, 22]);
    // A symbol is set in the size of the text around it.
    const diameter = texts[1];
    assert.ok(diameter.kind === 'text');
    assert.equal(diameter.text, 'Ø');
    assert.deepEqual(diameter.at, [0.045, 0.05]);
    assert.equal(diameter.height, 0.0035);
  });

  it('writes the sheet as SVG in millimetres, text fitted to the length SolidWorks laid it out in', () => {
    const svg = sheetSvg(drawing!.sheets[0]);
    assert.match(svg, /viewBox="0 0 420 297"/);
    assert.match(svg, /stroke="#ff0000"/);
    // x 10 mm, y from the top: 297 - 20.
    assert.match(svg, /M10 277L200 277/);
    assert.match(svg, />110<\/text>/);
    assert.match(svg, />Ø<\/text>/);
    assert.match(svg, /textLength="5.2"/);
  });

  it('reads the other sheet layout, where the border pen comes before the size', () => {
    // The pen record, then height, width and name with no sheet header of its own.
    const other = Buffer.concat([
      Buffer.alloc(32),
      pen(0x000000),
      segment(0.01, 0.01, 0.2, 0.01),
      pen(0x000000),
      f64(0.42, 0.297),
      text('1-Active'),
      Buffer.alloc(16),
    ]);
    const read = readDrawing([{ name: 'Contents/DisplayLists', offset: 0, data: other }]);
    assert.ok(read);
    assert.equal(read.sheets.length, 1);
    assert.equal(read.sheets[0].name, '1');
    assert.deepEqual([read.sheets[0].width, read.sheets[0].height], [0.297, 0.42]);
  });

  it('says so when a file keeps no sheet graphics', () => {
    assert.equal(readDrawing([]), null);
  });
});

describe('broken views', () => {
  // A channel 300 mm long on the sheet, broken twice, as SolidWorks wrote it.
  const point = (x: number, y: number) => f64(x, y, 0);
  const breakLine = (name: string, lo: number, hi: number) =>
    Buffer.concat([text(name), Buffer.alloc(215), point(0.02, lo), point(-0.02, lo), point(0.02, hi), point(-0.02, hi)]);
  const shifts = [0.0660187, 0.0238409, -0.0660187];
  const record = Buffer.concat([
    u32(shifts.length),
    ...shifts.map((dy) => f64(0, dy, 0)),
    Buffer.alloc(56),
    f64(0.0696, 0.0406, 0.1096, 0.3406),
    Buffer.alloc(16),
    u32(3),
    Buffer.alloc(4),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    f64(0.004, 0.003175),
  ]);
  const definition = Buffer.concat([
    Buffer.alloc(16),
    Buffer.from('moBreakLine_c', 'latin1'),
    Buffer.alloc(2),
    breakLine('Break Line1', -0.05017174, 0.04368781),
    breakLine('Break Line2', -0.13809454, -0.09191671),
    Buffer.alloc(400),
    record,
  ]);

  it('reads the bands each break cuts out and the view record with its gap', () => {
    const { bands, records } = readBreaks(definition);
    assert.equal(bands.length, 2);
    assert.deepEqual(bands[0], { axis: 1, lo: -0.05017174, hi: 0.04368781, across: [-0.02, 0.02] });
    assert.equal(records.length, 1);
    assert.equal(records[0].gap, 0.004);
    assert.equal(records[0].axis, 1);
    assert.deepEqual(records[0].shifts, shifts);
  });

  it('closes the pieces up around the middle of the view, the gap between each', () => {
    const pieces = breakLayout(readBreaks(definition).bands, 0.004);
    assert.ok(pieces);
    assert.deepEqual(
      pieces.map((p) => [p.lo, p.hi]),
      [
        [-Infinity, -0.13809454],
        [-0.09191671, -0.05017174],
        [0.04368781, Infinity],
      ],
    );
    // The same moves SolidWorks recorded.
    pieces.forEach((p, k) => assert.ok(Math.abs(p.shift - shifts[k]) < 1e-7, `piece ${k}: ${p.shift}`));
  });
});
