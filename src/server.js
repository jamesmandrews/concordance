import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { waitForDatabase, migrate, pool } from './db.js';
import routes from './routes.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  // Behind a reverse proxy, so take the client address and protocol from the
  // forwarded headers rather than the socket.
  trustProxy: true,
  bodyLimit: 2 * 1024 * 1024,   // a Quire manifest of a few thousand labels
});

await app.register(cookie);
await app.register(routes);

// Nothing here is mounted under a fixed base path. The app answers at "/" and
// the frontend only ever uses relative URLs, so a reverse proxy can expose it
// at any prefix it likes without the app knowing.
await app.register(fastifyStatic, { root: PUBLIC_DIR, index: ['index.html'] });

// A deep link such as /box/ATTIC-K7M2-9XQZ must still serve the shell.
app.setNotFoundHandler((req, reply) => {
  if (req.raw.url?.startsWith('/api/')) {
    return reply.code(404).send({ error: 'no such endpoint' });
  }
  return reply.sendFile('index.html');
});

for (const name of ['APP_PASSWORD', 'SESSION_SECRET', 'DATABASE_URL']) {
  if (!process.env[name]) {
    app.log.error(`${name} is not set — refusing to start`);
    process.exit(1);
  }
}

await waitForDatabase();
await migrate(app.log);

const close = async (signal) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => close('SIGTERM'));
process.on('SIGINT', () => close('SIGINT'));

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT) || 3000 });
