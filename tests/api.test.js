import { jest } from "@jest/globals";
import request from "supertest";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { createRepository } from "../src/repository.js";
const valid = {
  name: "Pessoa Teste",
  company: "Construtora Teste",
  email: "teste@example.com",
  phone: "+351 900 000 000",
  location: "Lisboa",
  service: "micro",
  message: "Pedido de teste",
  consent: true,
  locale: "pt-PT",
  website: "",
};
let directory, repository, app;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "concret-api-"));
  repository = createRepository({
    path: join(directory, "quotes.sqlite"),
    key: randomBytes(32).toString("base64"),
  });
  app = createApp({ repository });
});
afterEach(() => {
  repository.close();
  rmSync(directory, { recursive: true, force: true });
});
const send = (data = valid, key = randomUUID()) =>
  request(app)
    .post("/api/quotes")
    .set("Origin", "http://127.0.0.1:5173")
    .set("Idempotency-Key", key)
    .send(data);
test("persists a valid quote encrypted and returns an opaque reference", async () => {
  const result = await send();
  expect(result.status).toBe(201);
  expect(result.body.reference).toMatch(/^[a-f0-9-]{36}$/);
  expect(repository.count()).toBe(1);
  expect(
    readFileSync(join(directory, "quotes.sqlite")).includes(
      Buffer.from(valid.email),
    ),
  ).toBe(false);
  expect(repository.pending()[0].data.email).toBe(valid.email);
});
test("retries with the same key do not create duplicate records", async () => {
  const key = randomUUID();
  const first = await send(valid, key);
  const retry = await send(valid, key);
  expect(retry.body.reference).toBe(first.body.reference);
  expect(repository.count()).toBe(1);
});
test("rejects reuse of an idempotency key for changed data", async () => {
  const key = randomUUID();
  await send(valid, key);
  expect((await send({ ...valid, name: "Outra Pessoa" }, key)).status).toBe(
    409,
  );
  expect(repository.count()).toBe(1);
});
test.each([
  { ...valid, consent: false },
  { ...valid, email: "invalid" },
  { ...valid, name: "<script>alert(1)</script>" },
  { ...valid, website: "spam" },
  { ...valid, service: "unknown" },
  { ...valid, admin: true },
  { ...valid, message: "x".repeat(2001) },
])("rejects invalid, injected or unsolicited fields", async (data) => {
  expect((await send(data)).status).toBe(400);
  expect(repository.count()).toBe(0);
});
test("blocks untrusted origins", async () => {
  const result = await request(app)
    .post("/api/quotes")
    .set("Origin", "https://attacker.example")
    .set("Idempotency-Key", randomUUID())
    .send(valid);
  expect(result.status).toBe(403);
  expect(repository.count()).toBe(0);
});
test("blocks cross-site browser requests", async () => {
  const result = await request(app)
    .post("/api/quotes")
    .set("Sec-Fetch-Site", "cross-site")
    .send(valid);
  expect(result.status).toBe(403);
});
test("enforces JSON content type and request size", async () => {
  expect(
    (await request(app).post("/api/quotes").type("form").send(valid)).status,
  ).toBe(415);
  expect((await send({ ...valid, message: "x".repeat(15000) })).status).toBe(
    413,
  );
});
test("limits repeated submissions", async () => {
  app = createApp({ repository, limit: 2 });
  await send();
  await send();
  const result = await send();
  expect(result.status).toBe(429);
  expect(result.headers["retry-after"]).toBeDefined();
  expect(repository.count()).toBe(2);
});
test("applies security headers and never exposes stored requests", async () => {
  const health = await request(app).get("/api/health");
  expect(health.headers["x-powered-by"]).toBeUndefined();
  expect(health.headers["x-content-type-options"]).toBe("nosniff");
  expect(health.headers["cache-control"]).toBe("no-store");
  expect((await request(app).get("/api/quotes")).status).toBe(404);
});
test("database persists across repository instances", async () => {
  await send();
  repository.close();
  repository = createRepository({
    path: join(directory, "quotes.sqlite"),
    key: randomBytes(32).toString("base64"),
  });
  expect(repository.count()).toBe(1);
});
test("production refuses missing encryption key", () => {
  expect(() =>
    createRepository({
      path: join(directory, "production.sqlite"),
      production: true,
      key: undefined,
    }),
  ).toThrow("DATA_ENCRYPTION_KEY");
});
test("retention removes expired requests", async () => {
  await send();
  const now = jest
    .spyOn(Date, "now")
    .mockReturnValue(Date.now() + 91 * 86400000);
  try {
    expect(repository.purge()).toBe(1);
    expect(repository.count()).toBe(0);
  } finally {
    now.mockRestore();
  }
});
test("accepts multiline project descriptions", async () => {
  expect(
    (await send({ ...valid, message: "Primeira linha\nSegunda linha" })).status,
  ).toBe(201);
});
test("trusted proxy uses verified client IPs and rejects broad trust settings", async () => {
  expect(() => createApp({ repository, trustedProxyIps: ["true"] })).toThrow(
    "explicit IP",
  );
  app = createApp({
    repository,
    limit: 1,
    trustedProxyIps: ["127.0.0.1", "::ffff:127.0.0.1"],
  });
  const from = (ip) =>
    request(app)
      .post("/api/quotes")
      .set("X-Forwarded-For", ip)
      .set("Idempotency-Key", randomUUID())
      .send(valid);
  expect((await from("192.0.2.1")).status).toBe(201);
  expect((await from("192.0.2.1")).status).toBe(429);
  expect((await from("192.0.2.2")).status).toBe(201);
});
