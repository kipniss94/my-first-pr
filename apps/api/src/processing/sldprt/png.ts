import zlib from 'node:zlib';

/**
 * Just enough PNG to ask "is there ink here?" of the sheet pictures SolidWorks
 * keeps in a drawing: 8-bit, non-interlaced, grey / RGB / RGBA / palette.
 */
export interface PngRaster {
  width: number;
  height: number;
  /** True where the pixel is dark enough to be a line or a letter. */
  dark(x: number, y: number): boolean;
}

export function decodePng(buffer: Buffer): PngRaster | null {
  if (buffer.length < 33 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const kind = buffer.toString('latin1', at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      if (body[12] !== 0) return null;
    } else if (kind === 'PLTE') palette = body;
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    at += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (depth !== 8 || !channels || width === 0 || height === 0 || (type === 3 && !palette)) return null;
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let v = raw[row + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + x] = v & 0xff;
    }
  }
  const luminance = (x: number, y: number): number => {
    const o = y * stride + x * channels;
    if (type === 3 && palette) {
      const i = pixels[o] * 3;
      return (palette[i] + palette[i + 1] + palette[i + 2]) / 3;
    }
    return channels >= 3 ? (pixels[o] + pixels[o + 1] + pixels[o + 2]) / 3 : pixels[o];
  };
  return {
    width,
    height,
    dark: (x, y) => x >= 0 && y >= 0 && x < width && y < height && luminance(x, y) < 160,
  };
}
