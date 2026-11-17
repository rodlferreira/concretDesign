import { test, expect } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { createBlobRepository } from '../src/blob-repository.js';
function setup() {
  const files = new Map();
  const storage = {
    async get(path) {
      const entry = files.get(path);
      return entry ? { stream: new Response(entry.body).body } : null;
    },
    async put(path, body, options) {
      if (files.has(path) && !options.allowOverwrite) throw new Error('already_exists');
      files.set(path, { body, options });
    },
    async list() { return { blobs: [...files.keys()].filter(path => path.startsWith('quotes/')).map(pathname => ({ pathname })), hasMore: false }; },
  };
  return { files, repository: createBlobRepository({ key: randomBytes(32).toString('base64'), storage }) };
}
test('stores private encrypted records with retention, preserves idempotency and notification state', async () => {
  const { files, repository } = setup();
  const data = { name: 'Demo client', email: 'client@example.invalid' };
  const key = randomUUID();
  expect(await repository.save(data, key)).toBe(key);
  const entry = files.get(`quotes/${key}.bin`);
  expect(entry.body.toString()).not.toContain(data.email);
  expect(entry.options.access).toBe('private');
  expect(entry.options.ttlDays).toBe(90);
  expect(await repository.save(data, key)).toBe(key);
  await expect(repository.save({ ...data, name: 'Other' }, key)).rejects.toMatchObject({ status: 409 });
  expect(await repository.pending()).toEqual([{ id: key, data }]);
  await repository.markNotified(key);
  expect(await repository.pending()).toEqual([]);
});
test('concurrent requests preserve the first record', async () => {
  const { repository } = setup(); const key = randomUUID();
  const results = await Promise.allSettled([repository.save({ name: 'First' }, key), repository.save({ name: 'Second' }, key)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected').reason.status).toBe(409);
});
