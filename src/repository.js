import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  randomUUID,
} from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
export function createRepository({
  path = process.env.DATABASE_PATH || "./data/quotes.sqlite",
  key = process.env.DATA_ENCRYPTION_KEY,
  production = process.env.NODE_ENV === "production",
} = {}) {
  const directory = dirname(resolve(path));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!key) {
    if (production)
      throw new Error("DATA_ENCRYPTION_KEY is required in production");
    const keyPath = resolve(directory, ".encryption-key");
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32).toString("base64"), {
        mode: 0o600,
        flag: "wx",
      });
    key = readFileSync(keyPath, "utf8").trim();
  }
  const encryptionKey = Buffer.from(key, "base64");
  if (encryptionKey.length !== 32)
    throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes in base64");
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(
    "PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0)",
  );
  function encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }
  function decrypt(value) {
    const bytes = Buffer.from(value, "base64");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      bytes.subarray(0, 12),
    );
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString("utf8"),
    );
  }
  return {
    save(data, requestKey) {
      const existing = db
        .prepare("SELECT id,payload FROM quotes WHERE request_key=?")
        .get(requestKey);
      if (existing) {
        if (
          JSON.stringify(decrypt(existing.payload)) !== JSON.stringify(data)
        ) {
          const error = new Error("idempotency_conflict");
          error.status = 409;
          throw error;
        }
        return existing.id;
      }
      const id = randomUUID();
      db.prepare(
        "INSERT INTO quotes (id,request_key,created_at,payload) VALUES (?,?,?,?)",
      ).run(id, requestKey, Date.now(), encrypt(data));
      return id;
    },
    pending() {
      return db
        .prepare(
          "SELECT id,payload FROM quotes WHERE notified=0 ORDER BY created_at LIMIT 20",
        )
        .all()
        .map((row) => ({ id: row.id, data: decrypt(row.payload) }));
    },
    markNotified(id) {
      db.prepare("UPDATE quotes SET notified=1 WHERE id=?").run(id);
    },
    purge(days = 90) {
      if (!Number.isInteger(days) || days < 1 || days > 90)
        throw new Error("Retention must be 1–90 days");
      return db
        .prepare("DELETE FROM quotes WHERE created_at < ?")
        .run(Date.now() - days * 86400000).changes;
    },
    count() {
      return db.prepare("SELECT COUNT(*) as count FROM quotes").get().count;
    },
    close() {
      db.close();
    },
  };
}
