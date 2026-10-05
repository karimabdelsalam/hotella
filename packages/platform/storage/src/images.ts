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

/** The longest edge a vision model is sent (larger photos are scaled down on the platform first). */
export const MODEL_IMAGE_MAX_EDGE = 1568;

/** Larger inputs are refused rather than decoded (a decompression bomb would exhaust the worker). */
const MAX_INPUT_PIXELS = 50_000_000;

/**
 * A photo as it may leave the platform for a vision model (BUILD_PLAN 9.5): decoded and re-encoded as JPEG, so EXIF,
 * XMP, IPTC, GPS, ICC profiles and comments are all left behind; turned upright from its EXIF orientation first; the
 * longest edge at most `maxEdge`. Returns null for anything that is not a PNG, JPEG or WebP photo.
 */
export async function imageForModel(
  bytes: Uint8Array,
  maxEdge: number = MODEL_IMAGE_MAX_EDGE,
): Promise<{ bytes: Buffer; type: 'image/jpeg'; width: number; height: number } | null> {
  if (!sniffImage(bytes)) return null;
  const { default: sharp } = await import('sharp');
  try {
    const { data, info } = await sharp(bytes, {
      failOn: 'error',
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    return { bytes: data, type: 'image/jpeg', width: info.width, height: info.height };
  } catch {
    return null;
  }
}
