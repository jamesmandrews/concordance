import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const query = (text, params) => pool.query(text, params);

// Postgres inside compose is healthy before it is reachable from the app on
// the very first boot, and a restart loop here reads as a crash. Wait instead.
export async function waitForDatabase({ attempts = 30, delayMs = 1000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('select 1');
      return;
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// A migration runner rather than a dependency: the whole contract is "apply
// each db/*.sql once, in filename order, inside a transaction".
export async function migrate(log = console) {
  // Fastify's logger has .info, the console fallback has .log. Pick once:
  // `log.info?.(m) ?? log.log(m)` looks equivalent but is not, because info()
  // returns undefined on success and so the fallback always fires too.
  const note = typeof log.info === 'function' ? (m) => log.info(m) : (m) => log.log(m);

  await query(`
    create table if not exists migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(DB_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await query('select filename from migrations');
  const applied = new Set(rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(DB_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into migrations (filename) values ($1)', [file]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw new Error(`migration ${file} failed: ${err.message}`, { cause: err });
    } finally {
      client.release();
    }
    // Outside the try: a logging failure must never look like a failed
    // migration, nor trigger a rollback of work that already committed.
    note(`migrated ${file}`);
  }
}
