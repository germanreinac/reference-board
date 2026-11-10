// A small PDF maker: one picture per page, the page the same shape as the picture.
// Used to export frames (storyboard sheets, presentations) as one PDF file.
//
// makePdf(pages) where pages is [{ jpeg: Blob, width, height }] (the picture's pixels).
// Pages are A4-sized on their longest side (842 points), any shape.

export async function makePdf(pages) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let size = 0;
  const add = (p) => {
    const b = typeof p === 'string' ? enc.encode(p) : p;
    parts.push(b);
    size += b.size ?? b.length;
  };
  const obj = (n, body) => { offsets[n] = size; add(`${n} 0 obj\n${body}\nendobj\n`); };

  add('%PDF-1.4\n%âãÏÓ\n');
  const n = pages.length;
  // Objects: 1 catalog, 2 page list, then 3 per page: page, picture, drawing instructions.
  const pageObj = (i) => 3 + i * 3;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${n} >>`);
  pages.forEach((p, i) => {
    const k = 842 / Math.max(p.width, p.height);
    const w = (p.width * k).toFixed(2), h = (p.height * k).toFixed(2);
    const P = pageObj(i), IM = P + 1, C = P + 2;
    obj(P, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${IM} 0 R >> >> /Contents ${C} 0 R >>`);
    offsets[IM] = size;
    add(`${IM} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.size} >>\nstream\n`);
    add(p.jpeg);
    add('\nendstream\nendobj\n');
    const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(C, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
  });
  const count = 3 + n * 3;
  const xref = size;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  add(table);
  add(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
