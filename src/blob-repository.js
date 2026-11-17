import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { get, put, list } from '@vercel/blob';

// Immutable encrypted records; private Blob storage survives function restarts.
export function createBlobRepository({ key = process.env.DATA_ENCRYPTION_KEY,
  retention = Number(process.env.RETENTION_DAYS || 90), storage = { get, put, list } } = {}) {
  const encryptionKey = Buffer.from(key || '', 'base64');
  if (encryptionKey.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes in base64');
  if (!Number.isInteger(retention) || retention < 1 || retention > 90) throw new Error('Retention must be 1–90 days');
  const options = { access: 'private', addRandomSuffix: false, allowOverwrite: false,
    contentType: 'application/octet-stream', ttlDays: retention };
  function encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }
  function decrypt(bytes) {
    const cipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
  }
  async function read(path) {
    const result = await storage.get(path, { access: 'private', useCache: false });
    if (!result) return null;
    return decrypt(Buffer.from(await new Response(result.stream).arrayBuffer()));
  }
  function reference(existing, data) {
    if (JSON.stringify(existing.data) !== JSON.stringify(data)) {
      const error = new Error('idempotency_conflict'); error.status = 409; throw error;
    }
    return existing.id;
  }
  return {
    async save(data, requestKey) {
      const path = `quotes/${requestKey}.bin`;
      const existing = await read(path);
      if (existing) return reference(existing, data);
      const record = { id: requestKey, createdAt: Date.now(), data };
      try {
        await storage.put(path, encrypt(record), options);
      } catch (error) {
        // A concurrent request may have created the same immutable record.
        const winner = await read(path);
        if (winner) return reference(winner, data);
        throw error;
      }
      return record.id;
    },
    async pending() {
      const records = [];
      let cursor;
      do {
        const page = await storage.list({ prefix: 'quotes/', limit: 100, cursor });
        for (const blob of page.blobs) {
          const id = blob.pathname.slice('quotes/'.length, -4);
          if (await storage.get(`notified/${id}.bin`, { access: 'private', useCache: false })) continue;
          const record = await read(blob.pathname);
          if (record && record.createdAt > Date.now() - retention * 86400000) records.push({ id, data: record.data });
          if (records.length >= 20) return records;
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return records;
    },
    async markNotified(id) {
      await storage.put(`notified/${id}.bin`, 'sent', { ...options, allowOverwrite: true });
    },
  };
}
