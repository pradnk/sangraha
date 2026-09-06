/**
 * A hard ceiling on an uploaded file, whatever the question says.
 *
 * `maxSizeMb` is an organisation's own setting and tops out at 50 in the field
 * type's schema. This is the platform's limit rather than theirs, and exists so
 * a misconfigured form cannot turn into unbounded object storage.
 *
 * Lives here rather than beside the route that first checks it because two
 * places need it and a Next.js route module may only export handlers: the
 * reserve step, which refuses what the client *says* it will send, and the
 * moment of attachment, which is the first point at which the real size is
 * knowable. The second is what makes the first more than advisory — the
 * presigned PUT signs only `host`, so nothing obliges a client to send the
 * number of bytes it declared.
 */
export const ABSOLUTE_MAX_BYTES = 50 * 1024 * 1024;
