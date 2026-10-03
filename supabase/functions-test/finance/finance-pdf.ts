/**
 * A small, dependency-free PDF 1.4 writer (Finance Foundation F22; see
 * TEST-ENV.md "Finance Foundation - F22"). PURE + portable (Deno / Node): no
 * HTTP, no storage, no invoice knowledge. It owns ONLY document mechanics:
 *
 *   - pages (A4), text in the two standard fonts Helvetica / Helvetica-Bold
 *     (WinAnsiEncoding - nothing embedded), filled rectangles and lines;
 *   - text measuring (the standard Adobe font metrics) for wrapping and
 *     right-alignment;
 *   - one optional raster image (a logo): JPEG passed through, PNG decoded
 *     (8-bit, non-interlaced: grey / RGB / palette, alpha flattened onto
 *     white) and re-compressed;
 *   - a deterministic byte stream: the same input always gives the same
 *     bytes (no clock, no random ids; dates only if the caller passes them).
 *
 * Every byte of the output is 7-bit ASCII: text outside ASCII is written as
 * octal escapes and binary image data is ASCIIHex-encoded. So the stored
 * file, its SHA-256 and any text transport of it agree byte for byte.
 *
 * It never calculates money, dates or VAT - callers hand it final strings.
 */

export const A4 = { width: 595.28, height: 841.89 } as const;
export type FontName = "regular" | "bold";
export type Rgb = [number, number, number];

// ---------------------------------------------------------------------
// Text encoding + metrics (WinAnsiEncoding, standard 14 fonts)
// ---------------------------------------------------------------------

/** Unicode -> WinAnsi code for the 0x80-0x9F block (everything else Latin-1 maps 1:1). */
const WIN_ANSI_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e,
  0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** One WinAnsi byte per character; anything the font cannot show becomes its unaccented base letter, else "?" (never dropped silently). */
export function toWinAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.replace(/[\r\n\t]+/g, " ")) {
    const cp = ch.codePointAt(0) as number;
    if (cp >= 0x20 && cp <= 0x7e) out.push(cp);
    else if (cp >= 0xa0 && cp <= 0xff) out.push(cp);
    else if (WIN_ANSI_EXTRA[cp] !== undefined) out.push(WIN_ANSI_EXTRA[cp]);
    else {
      const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      const b = base.codePointAt(0);
      out.push(base.length === 1 && b !== undefined && ((b >= 0x20 && b <= 0x7e) || (b >= 0xa0 && b <= 0xff)) ? b : 0x3f);
    }
  }
  return out;
}

// Widths (1/1000 em) of WinAnsi 32..126 - Adobe Helvetica / Helvetica-Bold AFM.
const REG_ASCII = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const BOLD_ASCII = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
/** Upper-half codes with their own metrics; the rest take their base letter's width (accented letters are as wide as the letter in these fonts). */
const HIGH: Record<number, [number, number]> = {
  0x80: [556, 556], 0x85: [1000, 1000], 0x91: [222, 278], 0x92: [222, 278], 0x93: [333, 500], 0x94: [333, 500], 0x95: [350, 350], 0x96: [556, 556], 0x97: [1000, 1000], 0x99: [1000, 1000],
  0xa0: [278, 278], 0xa3: [556, 556], 0xa9: [737, 737], 0xae: [737, 737], 0xb0: [400, 400], 0xb7: [278, 278], 0xbd: [834, 834], 0xc6: [1000, 1000], 0xe6: [889, 889], 0xdf: [611, 611],
};
function widthOf(code: number, font: FontName): number {
  const bold = font === "bold";
  if (code >= 32 && code <= 126) return (bold ? BOLD_ASCII : REG_ASCII)[code - 32];
  const h = HIGH[code];
  if (h) return bold ? h[1] : h[0];
  if (code >= 0xc0) {
    const base = String.fromCharCode(code).normalize("NFD")[0];
    const b = base.charCodeAt(0);
    if (b >= 32 && b <= 126) return (bold ? BOLD_ASCII : REG_ASCII)[b - 32];
  }
  return 556;
}
/** Width of `text` in points at `size`. */
export function textWidth(text: string, font: FontName, size: number): number {
  let w = 0;
  for (const c of toWinAnsi(text)) w += widthOf(c, font);
  return (w * size) / 1000;
}

/** Word-wraps to `maxWidth`; a word longer than the line is broken by characters (nothing is ever clipped). */
export function wrapText(text: string, font: FontName, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of String(text).split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, font, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (textWidth(word, font, size) <= maxWidth) {
        line = word;
        continue;
      }
      let chunk = "";
      for (const ch of word) {
        if (textWidth(chunk + ch, font, size) > maxWidth && chunk) {
          lines.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      line = chunk;
    }
    lines.push(line);
  }
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A PDF literal string: ASCII escaped, every byte >= 0x80 as an octal escape - the file stays 7-bit. */
function pdfString(text: string): string {
  let s = "(";
  for (const c of toWinAnsi(text)) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) s += "\\" + String.fromCharCode(c);
    else if (c >= 0x20 && c <= 0x7e) s += String.fromCharCode(c);
    else s += "\\" + c.toString(8).padStart(3, "0");
  }
  return s + ")";
}
const num = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};
const colour = (c: Rgb) => c.map((v) => num(Math.max(0, Math.min(255, v)) / 255)).join(" ");

// ---------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------

/** A decoded raster ready to embed (data = the stream bytes for `filter`). */
export interface PdfImage {
  width: number;
  height: number;
  colorSpace: "DeviceRGB" | "DeviceGray";
  filter: "DCTDecode" | "FlateDecode";
  /** DCTDecode JPEGs: 1 (grey) or 3 (RGB) components. */
  data: Uint8Array;
}
export type ImageResult = { ok: true; image: PdfImage } | { ok: false; reason: string };

const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

function jpegInfo(b: Uint8Array): ImageResult {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return { ok: false, reason: "not a valid JPEG" };
    const marker = b[o + 1];
    const len = (b[o + 2] << 8) + b[o + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (marker !== 0xc0 && marker !== 0xc1 && marker !== 0xc2) return { ok: false, reason: "unsupported JPEG coding" };
      const height = (b[o + 5] << 8) + b[o + 6];
      const width = (b[o + 7] << 8) + b[o + 8];
      const comps = b[o + 9];
      if (!width || !height || (comps !== 1 && comps !== 3)) return { ok: false, reason: "unsupported JPEG colour" };
      return { ok: true, image: { width, height, colorSpace: comps === 1 ? "DeviceGray" : "DeviceRGB", filter: "DCTDecode", data: b } };
    }
    o += 2 + len;
  }
  return { ok: false, reason: "not a valid JPEG" };
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate");
  const buf = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const buf = await new Response(new Blob([data]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(buf);
}

/** PNG -> flat 8-bit RGB / grey (alpha composited on white), re-deflated. Interlaced / 16-bit / <8-bit PNGs are refused (text fallback). */
async function pngImage(b: Uint8Array): Promise<ImageResult> {
  let o = 8;
  let width = 0, height = 0, depth = 0, ctype = -1, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (o + 8 <= b.length) {
    const len = be32(b, o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    const data = b.subarray(o + 8, o + 8 + len);
    if (o + 12 + len > b.length) return { ok: false, reason: "truncated PNG" };
    if (type === "IHDR") {
      width = be32(data, 0);
      height = be32(data, 4);
      depth = data[8];
      ctype = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  if (!width || !height || width > 4000 || height > 4000) return { ok: false, reason: "unsupported PNG size" };
  if (depth !== 8 || interlace !== 0 || ![0, 2, 3, 4, 6].includes(ctype)) return { ok: false, reason: "unsupported PNG format (8-bit, non-interlaced only)" };
  if (ctype === 3 && !palette) return { ok: false, reason: "PNG palette missing" };
  const total = idat.reduce((a, d) => a + d.length, 0);
  const z = new Uint8Array(total);
  let p = 0;
  for (const d of idat) {
    z.set(d, p);
    p += d.length;
  }
  let raw: Uint8Array;
  try {
    raw = await inflate(z);
  } catch {
    return { ok: false, reason: "corrupt PNG data" };
  }
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype as 0 | 2 | 3 | 4 | 6];
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return { ok: false, reason: "corrupt PNG data" };
  // Undo the per-row PNG filters.
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0;
      const up = y > 0 ? px[row - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[row - stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const pp = a + up - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      } else if (f !== 0) return { ok: false, reason: "corrupt PNG filter" };
      px[row + x] = v & 0xff;
    }
  }
  const grey = ctype === 0 || ctype === 4;
  const outBpp = grey ? 1 : 3;
  const out = new Uint8Array(width * height * outBpp);
  const flat = (v: number, alpha: number) => Math.round((v * alpha + 255 * (255 - alpha)) / 255);
  for (let i = 0; i < width * height; i++) {
    if (ctype === 0) out[i] = px[i];
    else if (ctype === 4) out[i] = flat(px[i * 2], px[i * 2 + 1]);
    else if (ctype === 2) out.set(px.subarray(i * 3, i * 3 + 3), i * 3);
    else if (ctype === 6) for (let k = 0; k < 3; k++) out[i * 3 + k] = flat(px[i * 4 + k], px[i * 4 + 3]);
    else {
      const idx = px[i];
      if ((idx + 1) * 3 > (palette as Uint8Array).length) return { ok: false, reason: "corrupt PNG palette" };
      const alpha = trns && idx < trns.length ? trns[idx] : 255;
      for (let k = 0; k < 3; k++) out[i * 3 + k] = flat((palette as Uint8Array)[idx * 3 + k], alpha);
    }
  }
  return { ok: true, image: { width, height, colorSpace: grey ? "DeviceGray" : "DeviceRGB", filter: "FlateDecode", data: await deflate(out) } };
}

/** Decodes a logo for embedding; anything unsupported or corrupt is a reason (the caller falls back to text branding). */
export async function decodeImage(bytes: Uint8Array): Promise<ImageResult> {
  if (bytes.length > 2_000_000) return { ok: false, reason: "logo larger than 2 MB" };
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegInfo(bytes);
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    try {
      return await pngImage(bytes);
    } catch {
      return { ok: false, reason: "corrupt PNG" };
    }
  }
  return { ok: false, reason: "not a JPEG or PNG image" };
}

// ---------------------------------------------------------------------
// Document builder
// ---------------------------------------------------------------------

export interface DocInfo {
  title: string;
  author: string;
  subject: string;
  /** Optional fixed creation date (the caller's; never the clock). */
  creationDate?: string | null;
}

export class PdfBuilder {
  private pages: string[][] = [];
  private image: PdfImage | null = null;
  private readonly info: DocInfo;
  constructor(info: DocInfo) {
    this.info = info;
  }

  get pageCount(): number {
    return this.pages.length;
  }
  addPage(): number {
    this.pages.push([]);
    return this.pages.length - 1;
  }
  private ops(page: number): string[] {
    const p = this.pages[page];
    if (!p) throw new Error(`no page ${page}`);
    return p;
  }
  /** Text at baseline (x, y) - y measured from the TOP of the page. */
  text(page: number, x: number, yTop: number, s: string, opts: { font?: FontName; size?: number; colour?: Rgb; align?: "left" | "right" | "center" } = {}): void {
    if (!s) return;
    const font = opts.font ?? "regular";
    const size = opts.size ?? 9;
    const w = textWidth(s, font, size);
    const x0 = opts.align === "right" ? x - w : opts.align === "center" ? x - w / 2 : x;
    this.ops(page).push(`BT /${font === "bold" ? "F2" : "F1"} ${num(size)} Tf ${colour(opts.colour ?? [17, 24, 39])} rg ${num(x0)} ${num(A4.height - yTop)} Td ${pdfString(s)} Tj ET`);
  }
  rect(page: number, x: number, yTop: number, w: number, h: number, fill: Rgb): void {
    this.ops(page).push(`${colour(fill)} rg ${num(x)} ${num(A4.height - yTop - h)} ${num(w)} ${num(h)} re f`);
  }
  line(page: number, x1: number, y1Top: number, x2: number, y2Top: number, stroke: Rgb, width = 0.5): void {
    this.ops(page).push(`${colour(stroke)} RG ${num(width)} w ${num(x1)} ${num(A4.height - y1Top)} m ${num(x2)} ${num(A4.height - y2Top)} l S`);
  }
  /** The one image (logo), drawn into the box (x, yTop, w, h). */
  drawImage(page: number, img: PdfImage, x: number, yTop: number, w: number, h: number): void {
    this.image = img;
    this.ops(page).push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(A4.height - yTop - h)} cm /Im1 Do Q`);
  }

  /** Serialises the whole document. Pure + deterministic: same calls -> same bytes. */
  build(): Uint8Array {
    if (!this.pages.length) throw new Error("a PDF needs at least one page");
    const objs: string[] = [];
    // 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, [6 image], then page + content pairs.
    const imgObj = this.image ? 6 : 0;
    const first = this.image ? 7 : 6;
    const pageIds = this.pages.map((_, i) => first + i * 2);
    objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${this.pages.length} >>`;
    objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
    objs[5] = `<< /Title ${pdfString(this.info.title)} /Author ${pdfString(this.info.author)} /Subject ${pdfString(this.info.subject)} /Producer (Hub Finance)${this.info.creationDate ? ` /CreationDate ${pdfString(this.info.creationDate)}` : ""} >>`;
    if (this.image) {
      const img = this.image;
      const hex = Array.from(img.data, (b) => b.toString(16).padStart(2, "0")).join("").replace(/(.{128})/g, "$1\n") + ">";
      objs[imgObj] = `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /${img.colorSpace} /BitsPerComponent 8 /Filter [/ASCIIHexDecode /${img.filter}] /Length ${hex.length} >>\nstream\n${hex}\nendstream`;
    }
    const resources = `<< /Font << /F1 3 0 R /F2 4 0 R >>${this.image ? ` /XObject << /Im1 ${imgObj} 0 R >>` : ""} >>`;
    this.pages.forEach((ops, i) => {
      const content = ops.join("\n");
      objs[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources ${resources} /Contents ${pageIds[i] + 1} 0 R >>`;
      objs[pageIds[i] + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    });
    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (let id = 1; id < objs.length; id++) {
      offsets[id] = out.length;
      out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    for (let i = 0; i < out.length; i++) if (out.charCodeAt(i) > 0x7e && out.charCodeAt(i) !== 0x0a) throw new Error("PDF writer produced a non-ASCII byte");
    return new TextEncoder().encode(out);
  }
}

/** Lower-case hex SHA-256 of exact bytes (Web Crypto: Deno + Node). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
