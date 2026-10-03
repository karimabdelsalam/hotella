/** Images the platform accepts from people (logos, inspection photos). SVG is refused on purpose: it can carry script. */
export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';

export const IMAGE_EXTENSIONS: Readonly<Record<ImageType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** The image type read from the bytes themselves (never trusted from a declared content type). */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const at = (i: number, ...expected: number[]) => expected.every((b, k) => bytes[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}
