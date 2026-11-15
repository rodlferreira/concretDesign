import { createApp } from "./app.js";
import { createRepository } from "./repository.js";
import { createNotifier } from "./notifications.js";
const repository = createRepository();
const retention = Number(process.env.RETENTION_DAYS || 90);
repository.purge(retention);
const notifier = createNotifier(repository);
const app = createApp({
  repository,
  trustedProxyIps: (process.env.TRUSTED_PROXY_IPS || "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean),
  origins: (
    process.env.ALLOWED_ORIGINS || "http://127.0.0.1:5173,http://localhost:5173"
  )
    .split(",")
    .map((x) => x.trim()),
});
const server = app.listen(
  Number(process.env.PORT || 3001),
  process.env.HOST || "127.0.0.1",
  () =>
    console.log(
      `ConcretDesign API: http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3001}`,
    ),
);
const cleanup = setInterval(() => repository.purge(retention), 3600000);
cleanup.unref();
const notifications = setInterval(() => void notifier.flush(), 60000);
notifications.unref();
void notifier.flush();
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(cleanup);
  clearInterval(notifications);
  server.close(() => {
    repository.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
