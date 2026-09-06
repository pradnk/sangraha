import { getAttachment, getObject } from '@sangraha/db';
import { requireSession, withSession } from '@/lib/auth/guard';

/**
 * Serves one attachment.
 *
 * Proxied rather than redirected to a presigned URL, deliberately. A presigned
 * GET is a bearer token for that file: whoever holds the link can read it, from
 * anywhere, until it expires — and links get forwarded, logged by proxies and
 * pasted into chats. These are photographs of people the organisation works
 * with. Whether the viewer is allowed to see one is decided here, on every
 * request, by the same Row-Level Security that governs every other read.
 *
 * `withSession` is what enforces that: the row simply is not visible to a
 * worker outside the tenant, so a guessed uuid returns 404 rather than a file.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireSession();

  // A malformed id is a 404, not a 500 — the database would otherwise reject
  // the cast and turn a mistyped URL into an error page.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response(null, { status: 404 });

  const attachment = await withSession(session, (tx) => getAttachment(tx, id));
  if (!attachment) return new Response(null, { status: 404 });

  const object = await getObject(attachment.storageKey);
  if (!object?.body) {
    /*
     * The row exists but the bytes do not. The normal cause is an upload that
     * was reserved and never completed — a worker who backed out between
     * choosing a photo and it finishing. Distinguished from a missing row so it
     * reads differently in a log.
     */
    return new Response(null, { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      // The type recorded when the upload was authorised, never one the
      // uploader asserted at PUT time — the presigned URL does not sign it.
      'Content-Type': attachment.mimeType,
      /*
       * From the object, falling back to the column.
       *
       * The column is written from a size the client declared at reserve time,
       * and `reconcileAttachments` corrects it when the file is attached — but
       * a row that predates that, or one whose storage was unreachable then,
       * still holds the claim rather than the fact. A `Content-Length` that
       * disagrees with the body is a malformed response, so the object's own
       * header wins wherever storage gave us one.
       */
      'Content-Length': object.headers.get('content-length') ?? String(attachment.sizeBytes),
      /*
       * Private and revalidated. An attachment is personal data behind an
       * authorisation check; a shared cache holding it would serve it to
       * whoever asked next, and `no-store` would re-download a photo every time
       * a reviewer scrolled past it.
       */
      'Cache-Control': 'private, max-age=0, must-revalidate',
      // Uploaded bytes served from our own origin: give the browser nothing to
      // second-guess and nothing to execute. Same posture as the logo route.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Content-Disposition': disposition(attachment.mimeType, attachment.originalFilename),
    },
  });
}

/**
 * Inline for images, an attachment for everything else.
 *
 * A reviewer needs to see a photo without downloading it, but a PDF rendered
 * inline from our origin is a document we did not write being displayed as if
 * we had. The filename is quoted and stripped of anything that could break out
 * of the header.
 */
function disposition(mimeType: string, filename: string | null): string {
  const kind = mimeType.startsWith('image/') ? 'inline' : 'attachment';
  if (!filename) return kind;

  const safe = filename.replace(/[^\w.\- ]/g, '_').slice(0, 100);
  return `${kind}; filename="${safe}"`;
}
