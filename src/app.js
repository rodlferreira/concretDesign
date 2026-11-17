import express from "express";
import { isIP } from "node:net";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
const text = (min, max) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine(
      (value) => !/[<>\u0000-\u001f\u007f]/.test(value),
      "Invalid characters",
    );
export const quoteSchema = z
  .object({
    name: text(2, 100),
    company: text(2, 150),
    email: z.email().max(254),
    phone: z
      .string()
      .trim()
      .max(30)
      .regex(/^[+\d\s()-]*$/)
      .default(""),
    location: text(2, 150),
    service: z.enum(["micro", "marmorino", "render", "mass", "finish"]),
    message: z
      .string()
      .trim()
      .max(2000)
      .refine(
        (value) =>
          !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
        "Invalid characters",
      )
      .default(""),
    consent: z.literal(true),
    locale: z
      .string()
      .max(20)
      .regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/),
    website: z.literal("").default(""),
  })
  .strict();
export function createApp({
  repository,
  origins = ["http://127.0.0.1:5173", "http://localhost:5173"],
  limit = 5,
  trustedProxyIps = [],
  onSaved = async () => {},
} = {}) {
  if (!repository) throw new Error("Repository required");
  const app = express();
  app.disable("x-powered-by");
  if (trustedProxyIps.some((ip) => !isIP(ip)))
    throw new Error("Trusted proxies must be explicit IP addresses");
  if (trustedProxyIps.length) app.set("trust proxy", trustedProxyIps);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const origin = req.get("origin");
    if (
      (origin && !origins.includes(origin)) ||
      req.get("sec-fetch-site") === "cross-site"
    )
      return res.status(403).json({ error: "origin_not_allowed" });
    if (origin) {
      res.set("Access-Control-Allow-Origin", origin);
      res.vary("Origin");
    }
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key");
      return res.sendStatus(204);
    }
    next();
  });
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "rate_limited" },
  });
  app.post(
    "/api/quotes",
    limiter,
    (req, res, next) => {
      if (!req.is("application/json"))
        return res.status(415).json({ error: "json_required" });
      next();
    },
    express.json({ limit: "12kb" }),
    async (req, res, next) => {
      const parsed = quoteSchema.safeParse(req.body);
      const requestKey = z.uuid().safeParse(req.get("Idempotency-Key"));
      if (!parsed.success || !requestKey.success)
        return res.status(400).json({ error: "invalid_request" });
      try {
        const { website, ...data } = parsed.data;
        const id = await repository.save(data, requestKey.data);
        await onSaved();
        res.status(201).json({ reference: id });
      } catch (error) {
        next(error);
      }
    },
  );
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((error, _req, res, _next) => {
    const status =
      error.status === 413
        ? 413
        : error.status === 400
          ? 400
          : error.status === 409
            ? 409
            : 500;
    if (status === 500)
      console.error("Request failed:", error.code || error.name);
    res
      .status(status)
      .json({
        error:
          status === 409
            ? "idempotency_conflict"
            : status === 500
              ? "internal_error"
              : "invalid_request",
      });
  });
  return app;
}
