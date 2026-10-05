import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { imageForModel, MODEL_IMAGE_MAX_EDGE, sniffImage } from './images';

/** A phone photo as it arrives: 4000×3000, rotated by EXIF, with the owner's name, camera and GPS in its metadata. */
async function phonePhoto(): Promise<Buffer> {
  return sharp({
    create: { width: 4000, height: 3000, channels: 3, background: { r: 30, g: 90, b: 160 } },
  })
    .withExif({
      IFD0: { Artist: 'Giulia Rossi', Copyright: 'Giulia Rossi', Make: 'PhoneMaker', Model: 'X1' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '30/1 2/1 44/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '31/1 14/1 9/1',
      },
    })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}

describe('imageForModel (BUILD_PLAN 9.5)', () => {
  it('re-encodes without any metadata, upright and at most 1568 px', async () => {
    const original = await phonePhoto();
    const before = await sharp(original).metadata();
    expect(before.exif).toBeDefined();
    expect(original.includes('Giulia Rossi')).toBe(true);

    const out = await imageForModel(original);
    expect(out).not.toBeNull();
    const after = await sharp(out!.bytes).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.iptc).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    expect(out!.bytes.includes('Giulia Rossi')).toBe(false);
    expect(out!.bytes.includes('PhoneMaker')).toBe(false);
    // Orientation 6 (rotate 90°): the landscape sensor image is a portrait photo.
    expect([out!.width, out!.height]).toEqual([1176, MODEL_IMAGE_MAX_EDGE]);
    expect(sniffImage(out!.bytes)).toBe('image/jpeg');
  });

  it('keeps small photos at their size and reads PNG and WebP too', async () => {
    const png = await sharp({
      create: { width: 640, height: 480, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();
    expect(await imageForModel(png)).toMatchObject({ width: 640, height: 480, type: 'image/jpeg' });
    const webp = await sharp(png).webp().toBuffer();
    expect(await imageForModel(webp)).toMatchObject({ width: 640, height: 480 });
  });

  it('refuses what is not a photo, or is broken', async () => {
    expect(
      await imageForModel(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeNull();
    expect(await imageForModel(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]))).toBeNull();
  });
});
