/**
 * Object storage: the signature, and the round trip.
 *
 * The presigner is written by hand rather than taken from the AWS SDK, so the
 * part worth testing is that a real S3 implementation accepts what it produces
 * — not that the string looks plausible. The round trip runs against the MinIO
 * in `infra/docker-compose.yml` and skips itself when that is not up, in the
 * same way the database suites do.
 */
import { describe, expect, it } from 'vitest';
import {
  objectSize,
  presignedUrl,
  storageConfig,
  storageKeyFor,
  type StorageConfig,
} from '../storage/objects';

const config = storageConfig();

async function reachable(): Promise<boolean> {
  if (!config) return false;
  try {
    // MinIO answers this without credentials; a 403 still proves it is up.
    const response = await fetch(`${config.endpoint}/minio/health/live`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

const live = await reachable();

describe('storageKeyFor', () => {
  it('puts every object under its organisation', () => {
    const key = storageKeyFor('11111111-1111-1111-1111-111111111111', 'abc', 'jpg');
    expect(key).toBe('org/11111111-1111-1111-1111-111111111111/abc.jpg');
  });

  it('refuses to let an extension escape the key', () => {
    // A filename is attacker-controlled. "../../etc/passwd" as an extension
    // must not become a path, and a leading dot must not hide the object.
    const key = storageKeyFor('org-id', 'att-id', '../../evil');
    expect(key).toBe('org/org-id/att-id.evil');
    expect(key).not.toContain('..');
    expect(key).not.toContain('/att-id/');
  });

  it('copes with a file that has no extension at all', () => {
    expect(storageKeyFor('o', 'a', '')).toBe('org/o/a');
  });
});

describe('presignedUrl', () => {
  const fixture: StorageConfig = {
    endpoint: 'https://example.test',
    region: 'us-east-1',
    bucket: 'bucket',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
    forcePathStyle: true,
  };

  it('signs with the parameters S3 requires', () => {
    const url = new URL(presignedUrl(fixture, 'PUT', 'org/a/b.jpg'));

    expect(url.pathname).toBe('/bucket/org/a/b.jpg');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/us-east-1/s3/aws4_request');
  });

  it('addresses the bucket as a subdomain when path style is off', () => {
    const url = new URL(presignedUrl({ ...fixture, forcePathStyle: false }, 'GET', 'k'));
    expect(url.host).toBe('bucket.example.test');
    expect(url.pathname).toBe('/k');
  });

  it('gives a different signature per method', () => {
    // The method is part of the canonical request, so a URL minted for reading
    // cannot be replayed as a write.
    const get = new URL(presignedUrl(fixture, 'GET', 'k')).searchParams.get('X-Amz-Signature');
    const put = new URL(presignedUrl(fixture, 'PUT', 'k')).searchParams.get('X-Amz-Signature');
    expect(get).not.toBe(put);
  });
});

describe.skipIf(!live)('round trip against object storage', () => {
  it('uploads, reads back, and deletes', async () => {
    if (!config) return;
    const key = storageKeyFor('00000000-0000-0000-0000-000000000000', `test-${Date.now()}`, 'txt');
    const body = 'sangraha attachment round trip';

    const put = await fetch(presignedUrl(config, 'PUT', key), { method: 'PUT', body });
    expect(put.status, await put.clone().text()).toBeLessThan(300);

    const read = await fetch(presignedUrl(config, 'GET', key));
    expect(read.ok).toBe(true);
    expect(await read.text()).toBe(body);

    const removed = await fetch(presignedUrl(config, 'DELETE', key), { method: 'DELETE' });
    expect(removed.ok).toBe(true);

    const gone = await fetch(presignedUrl(config, 'GET', key));
    expect(gone.status).toBe(404);
  });

  it('measures what is really there, not what was claimed', async () => {
    /*
     * The number recorded when an upload is authorised is the one the *client*
     * declared, and the presigned PUT signs only `host` — so nothing in the
     * request obliges it to send that many bytes. The size limit was therefore
     * advisory, and the `Content-Length` the download route set from that
     * column was a claim rather than a fact. This is how it gets checked.
     */
    if (!config) return;
    const key = storageKeyFor('00000000-0000-0000-0000-000000000000', `size-${Date.now()}`, 'bin');

    // Deliberately not the size anybody declared.
    const bytes = new Uint8Array(4096).fill(7);
    const put = await fetch(presignedUrl(config, 'PUT', key), { method: 'PUT', body: bytes });
    expect(put.status).toBeLessThan(300);

    expect(await objectSize(key)).toBe(4096);

    await fetch(presignedUrl(config, 'DELETE', key), { method: 'DELETE' });
  });

  it('reports null for an object that is not there', async () => {
    // Told apart from a size of zero, because the caller treats an unreachable
    // object as "cannot check" and a real size as "checked".
    expect(await objectSize('org/none/does-not-exist.bin')).toBeNull();
  });
});
