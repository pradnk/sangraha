import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getFieldType, resolveFieldConfig } from '@sangraha/form-engine';
import {
  createAttachment,
  isStorageConfigured,
  loadFormVersionById,
  presignedUrl,
  storageConfig,
  storageKeyFor,
} from '@sangraha/db';
import { requireSession, withSession } from '@/lib/auth/guard';
import { ABSOLUTE_MAX_BYTES } from '@/lib/attachment-limits';

/**
 * Reserves a place to put a photo, a document or a signature.
 *
 * Returns a row id and a short-lived URL the browser PUTs the bytes to. The
 * bytes never pass through here: a serverless platform caps the request body it
 * will accept — 4.5 MB on Vercel — and a form may legitimately ask for a 10 MB
 * scan, so an upload proxied through this function would fail at the framework
 * boundary with an error we never get to explain.
 *
 * Everything that decides *whether* the upload is allowed still happens here,
 * on the server: which question it answers, what type it may be, and how large.
 * The presigned URL is for one key and expires in minutes.
 *
 * The size, though, is the one thing this cannot settle on its own. `sizeBytes`
 * is what the *client* says it is about to send, and the presigned PUT signs
 * only `host` — deliberately, so the browser is not asked to match a signed
 * content-type it may adjust. Nothing in the request obliges it to send that
 * many bytes. The claim is checked against the object itself when the file is
 * attached to a record; see `reconcileAttachments` in the submissions route.
 *
 * The row is written before the bytes arrive, so a worker who abandons the form
 * leaves an unclaimed row behind. That is the designed outcome — see
 * `claimAttachments` and `findOrphanedAttachments`.
 */

const bodySchema = z.object({
  formVersionId: z.string().uuid(),
  /** Which question this answers. Checked against the form, never trusted. */
  fieldKey: z.string().min(1).max(120),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  filename: z.string().max(255).optional(),
});

export async function POST(request: Request) {
  const session = await requireSession();

  if (!isStorageConfigured()) {
    // Said plainly, because the alternative is a worker tapping a camera button
    // that silently does nothing on a deployment nobody configured storage for.
    return NextResponse.json({ error: 'storage_not_configured' }, { status: 503 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }

  const body = parsed.data;

  return withSession(session, async (tx) => {
    const version = await loadFormVersionById(tx, body.formVersionId);
    if (!version) return NextResponse.json({ error: 'unknown_form_version' }, { status: 404 });

    const field = version.fields.find((f) => f.key === body.fieldKey);
    if (!field) return NextResponse.json({ error: 'unknown_field' }, { status: 404 });

    // The question has to actually be one that takes a file. Without this, any
    // signed-in worker could mint upload URLs against any form.
    const definition = getFieldType(field.dataType);
    if (!definition.isAttachment) {
      return NextResponse.json({ error: 'not_an_attachment_field' }, { status: 400 });
    }

    const config = resolveFieldConfig(field) as {
      acceptedMimeTypes?: string[];
      maxSizeMb?: number;
    };

    const limit = Math.min(
      config.maxSizeMb ? config.maxSizeMb * 1024 * 1024 : ABSOLUTE_MAX_BYTES,
      ABSOLUTE_MAX_BYTES,
    );
    if (body.sizeBytes > limit) {
      return NextResponse.json({ error: 'too_large', maxBytes: limit }, { status: 413 });
    }

    if (!typeIsAccepted(body.mimeType, config.acceptedMimeTypes, field.dataType)) {
      return NextResponse.json({ error: 'unsupported_type' }, { status: 415 });
    }

    const store = storageConfig();
    if (!store) return NextResponse.json({ error: 'storage_not_configured' }, { status: 503 });

    /*
     * The id is minted here so the storage key can contain it before the row
     * exists. The key is derived only from ids we generated — a filename
     * arrives from a phone's file picker and has no business deciding a path.
     * The original name is kept as a column, for display and for the download.
     */
    const id = crypto.randomUUID();
    const storageKey = storageKeyFor(
      session.orgId,
      id,
      extensionFor(body.mimeType, body.filename),
    );

    const attachment = await createAttachment(tx, {
      id,
      orgId: session.orgId,
      fieldKey: field.key,
      storageKey,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      originalFilename: body.filename ?? null,
      uploadedBy: session.userId,
    });

    return NextResponse.json(
      {
        id: attachment.id,
        uploadUrl: presignedUrl(store, 'PUT', storageKey),
        // Short. The browser PUTs immediately; a URL that outlived the tab
        // would be a write capability sitting in someone's history.
        expiresInSeconds: 600,
      },
      { status: 201 },
    );
  });
}

/**
 * Whether the question accepts this kind of file.
 *
 * `acceptedMimeTypes` uses the same `image/*` wildcard an `<input accept>` does,
 * because that is what an admin is used to writing. A photo question is images
 * only regardless of what its config says — a "photo" that is a PDF is a
 * misconfiguration, not a preference.
 */
function typeIsAccepted(
  mimeType: string,
  accepted: string[] | undefined,
  dataType: string,
): boolean {
  if (dataType === 'photo' || dataType === 'signature') return mimeType.startsWith('image/');
  if (!accepted || accepted.length === 0) return true;

  return accepted.some((pattern) =>
    pattern.endsWith('/*')
      ? mimeType.startsWith(pattern.slice(0, -1))
      : pattern === mimeType,
  );
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

function extensionFor(mimeType: string, filename?: string): string {
  const known = EXTENSIONS[mimeType];
  if (known) return known;

  // Falls back to the uploader's own extension, which `storageKeyFor` strips to
  // letters and digits — it names the object, it does not choose the path.
  const match = filename?.match(/\.([A-Za-z0-9]{1,8})$/);
  return match ? match[1]! : 'bin';
}
