import { createApp } from '../src/app.js';
import { createBlobRepository } from '../src/blob-repository.js';
import { createNotifier } from '../src/notifications.js';
const repository = createBlobRepository();
const notifier = createNotifier(repository);
const app = createApp({ repository, onSaved: () => notifier.flush(),
  origins: (process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
});
// Await notifications inside the invocation; serverless has no durable timers.
export default async function handler(req, res) {
  if (req.url.split('?')[0] === '/api/cron') {
    if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      res.statusCode = 401; return res.end();
    }
    await notifier.flush();
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ status: 'ok' }));
  }
  return app(req, res);
}
