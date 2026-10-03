import qrcode from 'qrcode-generator';

/** One printable card: an opaque URL (no guest data, Spec §20) and the room it names. */
export interface QrCard {
  readonly roomNumber: string;
  readonly url: string;
}

export interface QrSheetText {
  readonly title: string;
  readonly room: string;
  readonly instruction: string;
  readonly attribution: { readonly label: string; readonly href: string } | null;
}

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** QR code as an inline, scalable SVG (error correction M, quiet zone of 4 modules). */
export function qrSvg(data: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(data, 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
}

/**
 * A printable A4 sheet of room cards (browser print → paper or PDF). Logical CSS properties only, so the same page
 * works left-to-right and right-to-left (CLAUDE.md rule 8). Nothing hotel-specific is hardcoded: the title and
 * texts come from the caller (localized), the attribution line follows the platform policy (rule 15).
 */
export function renderQrSheet(
  cards: readonly QrCard[],
  text: QrSheetText,
  locale: string,
  dir: 'ltr' | 'rtl',
): string {
  const items = cards
    .map(
      (c) => `<section class="card">
  <h2>${esc(text.room)} ${esc(c.roomNumber)}</h2>
  <div class="qr">${qrSvg(c.url)}</div>
  <p>${esc(text.instruction)}</p>
</section>`,
    )
    .join('\n');
  const footer = text.attribution
    ? `<footer><a href="${esc(text.attribution.href)}">${esc(text.attribution.label)}</a></footer>`
    : '';
  return `<!doctype html>
<html lang="${esc(locale)}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>${esc(text.title)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  body { font-family: system-ui, "Noto Sans", "Noto Sans Arabic", sans-serif; margin: 0; }
  h1 { font-size: 14pt; margin-block: 0 6mm; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8mm; }
  .card { border: 1px solid #999; border-radius: 3mm; padding-block: 6mm; padding-inline: 6mm; text-align: center;
    break-inside: avoid; }
  .card h2 { font-size: 18pt; margin-block: 0 4mm; }
  .qr svg { inline-size: 55mm; block-size: 55mm; }
  .card p { font-size: 11pt; margin-block: 4mm 0; }
  footer { margin-block-start: 6mm; font-size: 8pt; text-align: center; }
  footer a { color: inherit; }
</style>
</head>
<body>
<h1>${esc(text.title)}</h1>
<div class="grid">
${items}
</div>
${footer}
</body>
</html>
`;
}
