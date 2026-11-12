// PDF text extraction through the shipped extractPdfChunks, in workerd (the production runtime).
//
// WHY THIS EXISTS. extractPdfChunks (src/routes/rag.ts) is the only caller of unpdf, and it is what
// document upload, the zip import and the Discord import reach for every PDF. Until this file, no
// committed test exercised it: the suite only proved the module LOADS, because src/index.ts imports
// rag.ts, which imports unpdf. unpdf 1.8.1 -> 2.1.0 (a major, #221) was about to ship on that
// untested path, so this pins the behaviour prism depends on: per-page text, in page order, tagged
// with its 1-based page number.
//
// THE FIXTURE IS BUILT HERE, not committed as a binary: a minimal two-page PDF with one Helvetica
// text run per page and a correct xref, so the expected strings are visible in this file and nobody
// has to trust an opaque blob. Same shape as the probe measured before the v1.2.0 release.

import { describe, expect, it } from "vitest";
import { extractPdfChunks } from "../src/routes/rag";

const PAGE_TEXT = ["PRISMPROBE alpha page one", "PRISMPROBE beta page two"];

function minimalPdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const fontNum = 3 + pages.length * 2;
  pages.forEach((text, i) => {
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R ` +
        `/Resources << /Font << /F1 ${fontNum} 0 R >> >> >>`,
    );
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  // ASCII only, so string length is byte length and the xref offsets are exact.
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, n) => {
    offsets.push(out.length);
    out += `${n + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe("extractPdfChunks (unpdf), in workerd", () => {
  it("extracts each page's text in order, tagged with its 1-based page number", async () => {
    const chunks = await extractPdfChunks(minimalPdf(PAGE_TEXT));
    expect(chunks).toEqual([
      { text: PAGE_TEXT[0], page: 1 },
      { text: PAGE_TEXT[1], page: 2 },
    ]);
  });

  it("skips a page with no text layer instead of emitting an empty chunk", async () => {
    // The middle page draws nothing: an empty text layer, the shape of a scanned page.
    const pdf = minimalPdf([PAGE_TEXT[0], "", PAGE_TEXT[1]]);
    const chunks = await extractPdfChunks(pdf);
    expect(chunks).toEqual([
      { text: PAGE_TEXT[0], page: 1 },
      { text: PAGE_TEXT[1], page: 3 },
    ]);
  });

  it("rejects bytes that are not a PDF, rather than returning an empty success", async () => {
    await expect(extractPdfChunks(new TextEncoder().encode("not a pdf at all"))).rejects.toThrow();
  });
});
