import { createHash, createHmac } from 'node:crypto';

/**
 * S3-compatible object storage.
 *
 * Lives in the persistence package rather than the web app because it is not
 * only the web app that needs it. `scripts/purge.ts` carries out erasures from
 * a terminal, and an erasure that cannot delete somebody's photograph is not an
 * erasure — so the CLI needs the same signer the API routes use, and a module
 * marked `server-only` cannot be imported by `tsx`.
 *
 * Photos, documents and signatures go here rather than into Postgres — unlike a
 * logo, which is one small file per organisation and is served before anyone has
 * signed in, these are unbounded in number and would turn the database into a
 * file server. `infra/docker-compose.yml` runs MinIO locally; the SaaS target is
 * Cloudflare R2 and the code is the same.
 *
 * Requests are signed here rather than with the AWS SDK. Presigning is one
 * HMAC chain against a documented string, and the SDK is tens of megabytes in a
 * serverless bundle for that one thing — the same trade already made for the
 * Google service-account signer in `lib/translation/service-account.ts`.
 *
 * Uploads go from the browser straight to storage with a presigned PUT, because
 * a serverless platform caps the request body it will accept (4.5 MB on Vercel)
 * and a form may legitimately ask for a 10 MB document. Downloads are the
 * opposite: they are proxied through `/api/attachments/[id]` so that whether the
 * viewer is allowed to see the file is decided by our own code, every time. A
 * presigned GET handed to the browser would be a bearer token for that file,
 * valid for anyone it was forwarded to.
 */

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export function storageConfig(): StorageConfig | null {
  const endpoint = process.env.S3_ENDPOINT?.trim();
  const bucket = process.env.S3_BUCKET?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    region: process.env.S3_REGION?.trim() || 'us-east-1',
    bucket,
    accessKeyId,
    secretAccessKey,
    // MinIO addresses buckets as a path segment; R2 and S3 use a subdomain.
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  };
}

/** True when attachments can be stored at all. Photo and file questions are hidden otherwise. */
export function isStorageConfigured(): boolean {
  return storageConfig() !== null;
}

/**
 * Where an object lives.
 *
 * Organisation first, so a tenant's objects share a prefix and a bulk lifecycle
 * rule or a bucket listing can be scoped to one of them. The uuid is the
 * attachment's own id, which makes the mapping between row and object obvious
 * when something has to be reconciled by hand.
 */
export function storageKeyFor(orgId: string, attachmentId: string, extension: string): string {
  const safe = extension.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
  return `org/${orgId}/${attachmentId}${safe ? `.${safe}` : ''}`;
}

/**
 * Percent-encoding as S3 defines it for signing.
 *
 * `encodeURIComponent` leaves `!'()*` alone and AWS does not, so a key
 * containing one would sign correctly and then fail on the wire. Slashes are
 * kept literal in a path and escaped in a query value, which is the `forPath`
 * switch.
 */
function uriEncode(value: string, forPath: boolean): string {
  return value
    .split('')
    .map((character) => {
      if (/[A-Za-z0-9\-._~]/.test(character)) return character;
      if (character === '/' && forPath) return '/';
      return Array.from(new TextEncoder().encode(character))
        .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
        .join('');
    })
    .join('');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

type Method = 'GET' | 'PUT' | 'HEAD' | 'DELETE';

/**
 * A presigned URL for one object and one method.
 *
 * `UNSIGNED-PAYLOAD` is the standard choice for presigned URLs: the body is not
 * known when the URL is minted. The upload is still bounded — the row recording
 * the file was written with a size the server decided it would accept, and the
 * bytes are re-checked against it before the attachment is served or claimed.
 */
export function presignedUrl(
  config: StorageConfig,
  method: Method,
  key: string,
  expiresInSeconds = 600,
): string {
  const url = new URL(
    config.forcePathStyle
      ? `${config.endpoint}/${config.bucket}/${uriEncode(key, true)}`
      : `${config.endpoint.replace('://', `://${config.bucket}.`)}/${uriEncode(key, true)}`,
  );

  const now = new Date();
  const amzDate = `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;

  // Only `host` is signed. Signing content-type as well would mean the browser
  // had to send back byte-identical headers, and the type we care about is the
  // one recorded in the database and used when serving — never the one the
  // uploader claimed.
  const query = new Map<string, string>([
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${config.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresInSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ]);

  const canonicalQuery = [...query.entries()]
    .map(([name, value]) => [uriEncode(name, false), uriEncode(value, false)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Reads an object back. Used by the download proxy, which has already authorised the caller. */
export async function getObject(key: string): Promise<Response | null> {
  const config = storageConfig();
  if (!config) return null;

  // No cache hint: this package is also loaded by plain `tsx` scripts, whose
  // `RequestInit` has no `cache`, and Next 15 no longer caches fetch by default
  // anyway. A presigned URL is single-use in practice — the signature carries a
  // timestamp — so there is nothing stable to cache against.
  const response = await fetch(presignedUrl(config, 'GET', key));
  return response.ok ? response : null;
}

/**
 * How many bytes are actually in storage under this key.
 *
 * The size recorded when an upload is authorised is the one the *client*
 * declared, and the presigned PUT signs only `host` — deliberately, so the
 * browser is not made to match a signed content-type it may adjust. The
 * consequence is that nothing about the request obliges it to send the number
 * of bytes it said it would. This is how that claim gets checked against
 * reality: one HEAD, at the moment the file is attached to a record.
 *
 * Returns null when storage is unconfigured or the object is not there, which
 * the caller distinguishes from a size it can trust.
 */
export async function objectSize(key: string): Promise<number | null> {
  const config = storageConfig();
  if (!config) return null;

  try {
    const response = await fetch(presignedUrl(config, 'HEAD', key), { method: 'HEAD' });
    if (!response.ok) return null;
    const length = response.headers.get('content-length');
    if (length === null) return null;
    const size = Number(length);
    return Number.isFinite(size) && size >= 0 ? size : null;
  } catch {
    return null;
  }
}

/**
 * Removes an object.
 *
 * Erasure calls this. It reports success rather than throwing on a missing
 * object: S3 delete is idempotent, and an erasure that fails because the file
 * was already gone would leave a statutory request looking unfulfilled.
 */
export async function deleteObject(key: string): Promise<boolean> {
  const config = storageConfig();
  if (!config) return false;

  try {
    const response = await fetch(presignedUrl(config, 'DELETE', key), { method: 'DELETE' });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}
