'use client';

/**
 * Prepares a logo in the browser before it is uploaded.
 *
 * The problem this solves: an administrator picks the logo file they have —
 * often a 3 MB print-resolution PNG — and Next.js rejects the request at the
 * framework level with "Body exceeded 1 MB limit" before any of our own
 * validation runs. That surfaces as an unhandled error, which is a terrible
 * answer to a reasonable action.
 *
 * Refusing the file would be only slightly better. A header logo needs a few
 * hundred pixels; the right response to a large image is to make it the right
 * size, not to send the person away to find image-editing software. So it is
 * decoded, scaled down and re-encoded here, and what reaches the server is
 * already small.
 */

/** Generous for a header mark, and small enough to survive any body limit. */
const MAX_WIDTH = 1024;
const MAX_HEIGHT = 512;
const TARGET_BYTES = 200 * 1024;

/**
 * WebP, because it keeps transparency — logos are usually cut out — and is
 * markedly smaller than PNG. Supported by every browser this product targets,
 * including Chrome on Android.
 */
const OUTPUT_TYPE = 'image/webp';

export interface ResizePlan {
  /** False when the file is already fine and should be sent untouched. */
  needsWork: boolean;
  targetWidth: number;
  targetHeight: number;
}

/**
 * Decides what to do with an image, given only its dimensions, size and type.
 *
 * Pure, and separate from the canvas work, so the part with the actual judgement
 * in it can be tested without a browser.
 */
export function planLogoResize(
  width: number,
  height: number,
  byteSize: number,
  mimeType: string,
): ResizePlan {
  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);

  // Re-encoding a small, correctly sized PNG only loses quality for nothing.
  const alreadyFine =
    scale === 1 && byteSize <= TARGET_BYTES && PASSTHROUGH_TYPES.includes(mimeType);

  return {
    needsWork: !alreadyFine,
    targetWidth: Math.max(1, Math.round(width * scale)),
    targetHeight: Math.max(1, Math.round(height * scale)),
  };
}

export type PrepareResult =
  | { ok: true; file: File; wasResized: boolean }
  | { ok: false; reason: 'not_an_image' | 'unreadable' | 'still_too_large' };

const PASSTHROUGH_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export async function prepareLogo(file: File): Promise<PrepareResult> {
  if (!file.type.startsWith('image/')) return { ok: false, reason: 'not_an_image' };

  let bitmap: ImageBitmap | HTMLImageElement;
  try {
    bitmap = await decode(file);
  } catch {
    // A corrupt file, or an SVG referencing something external. Either way it
    // cannot be turned into a logo.
    return { ok: false, reason: 'unreadable' };
  }

  const width = 'width' in bitmap ? bitmap.width : 0;
  const height = 'height' in bitmap ? bitmap.height : 0;
  if (!width || !height) return { ok: false, reason: 'unreadable' };

  const plan = planLogoResize(width, height, file.size, file.type);
  if (!plan.needsWork) return { ok: true, file, wasResized: false };

  const canvas = document.createElement('canvas');
  canvas.width = plan.targetWidth;
  canvas.height = plan.targetHeight;

  const context = canvas.getContext('2d');
  if (!context) return { ok: false, reason: 'unreadable' };
  context.drawImage(bitmap as CanvasImageSource, 0, 0, canvas.width, canvas.height);

  // Step the quality down until it fits. Two attempts is enough in practice;
  // a logo that will not fit at 0.6 is not a logo.
  for (const quality of [0.92, 0.8, 0.6]) {
    const blob = await toBlob(canvas, OUTPUT_TYPE, quality);
    if (blob && blob.size <= TARGET_BYTES) {
      return {
        ok: true,
        file: new File([blob], renameTo(file.name, 'webp'), { type: OUTPUT_TYPE }),
        wasResized: true,
      };
    }
  }

  return { ok: false, reason: 'still_too_large' };
}

/**
 * How far to shrink a photograph taken in the field.
 *
 * Separate from the logo plan because the constraint is different. A logo is
 * bounded by a header; a photograph is bounded by the connection carrying it.
 * The question's own `maxWidthPx` is what decides, because only the
 * organisation knows whether it is collecting a portrait for identification or
 * a photograph of a crack in a wall — and the difference is several megabytes.
 *
 * Only ever downwards. Enlarging a small photo would add bytes and no detail.
 */
export function planPhotoResize(width: number, height: number, maxWidthPx: number): ResizePlan {
  const scale = Math.min(1, maxWidthPx / width);

  return {
    needsWork: scale < 1,
    targetWidth: Math.max(1, Math.round(width * scale)),
    targetHeight: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Prepares a captured photograph for upload.
 *
 * An 8 MP photo straight off a phone camera is 3–5 MB. On the 2G connection a
 * field worker actually has, that is the difference between a submission that
 * lands and one that times out — so it is decoded, scaled and re-encoded here,
 * and what leaves the phone is a couple of hundred kilobytes.
 *
 * JPEG rather than the WebP a logo gets: photographs have no transparency to
 * preserve, and JPEG is what every downstream viewer, exporter and print
 * pipeline an NGO might point at this already understands.
 */
export async function preparePhoto(
  file: File,
  maxWidthPx: number,
  quality: number,
): Promise<PrepareResult> {
  if (!file.type.startsWith('image/')) return { ok: false, reason: 'not_an_image' };

  let bitmap: ImageBitmap | HTMLImageElement;
  try {
    bitmap = await decode(file);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  const width = 'width' in bitmap ? bitmap.width : 0;
  const height = 'height' in bitmap ? bitmap.height : 0;
  if (!width || !height) return { ok: false, reason: 'unreadable' };

  const plan = planPhotoResize(width, height, maxWidthPx);

  /*
   * A photo that is already small enough is still re-encoded, unlike a logo.
   * The camera writes JPEG at close to maximum quality and embeds EXIF —
   * including, on many phones, the GPS coordinates of where it was taken. Going
   * through the canvas drops all of it. That is a privacy property worth the
   * re-encode: a photograph of a beneficiary should not carry their home
   * address in its metadata to whoever the data is later shared with.
   */
  const canvas = document.createElement('canvas');
  canvas.width = plan.targetWidth;
  canvas.height = plan.targetHeight;

  const context = canvas.getContext('2d');
  if (!context) return { ok: false, reason: 'unreadable' };
  context.drawImage(bitmap as CanvasImageSource, 0, 0, canvas.width, canvas.height);

  const blob = await toBlob(canvas, 'image/jpeg', quality);
  if (!blob) return { ok: false, reason: 'unreadable' };

  return {
    ok: true,
    file: new File([blob], renameTo(file.name, 'jpg'), { type: 'image/jpeg' }),
    wasResized: plan.needsWork,
  };
}

/**
 * Decodes to something drawable.
 *
 * `createImageBitmap` is the fast path but does not handle SVG in every browser,
 * so an `<img>` from a blob URL is the fallback. Rasterising an SVG here is also
 * why an SVG can be *accepted* at all: only the pixels are kept, never the
 * document, so there is nothing left that could carry script.
 */
async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (file.type !== 'image/svg+xml' && typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to the <img> path.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('decode failed'));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function renameTo(name: string, extension: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'logo';
  return `${base}.${extension}`;
}

export function describeSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
