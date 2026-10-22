import { query, pool } from './db.js';
import { COOKIE, checkPassword, issueSession, cookieOptions, requireSession, readSession } from './auth.js';

// The shape Quire mints: an optional prefix of up to 5, then two groups of
// four Crockford base32 characters. Enforced so that scanning a product
// barcode or a random QR in the wild cannot create junk rows.
const ID = /^(?:[0-9A-Z]{1,5}-)?[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;

const splitId = (id) => {
  const parts = id.split('-');
  return parts.length === 3
    ? { prefix: parts[0], suffix: `${parts[1]}-${parts[2]}` }
    : { prefix: null, suffix: id };
};

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

async function readBox(labelId) {
  const { rows } = await query(
    `select b.label_id, b.name, b.location, b.notes, b.created_at, b.updated_at, b.updated_by,
            coalesce(
              (select json_agg(i.description order by i.position, i.id)
               from items i where i.label_id = b.label_id), '[]'
            ) as items
       from boxes b where b.label_id = $1`,
    [labelId]
  );
  return rows[0] ?? null;
}

export default async function routes(app) {
  /* ---------- session ---------- */

  app.get('/api/session', async (req) => ({
    authenticated: Boolean(readSession(req.cookies?.[COOKIE])),
  }));

  app.post('/api/session', async (req, reply) => {
    if (!checkPassword(req.body?.password)) {
      return reply.code(401).send({ error: 'wrong password' });
    }
    reply.setCookie(COOKIE, issueSession(), cookieOptions(req));
    return { authenticated: true };
  });

  app.delete('/api/session', async (req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { authenticated: false };
  });

  /* ---------- everything below needs a session ---------- */

  app.register(async (secure) => {
    secure.addHook('onRequest', requireSession);

    // The scan endpoint. An unknown ID is a normal answer, not an error --
    // printing happens before anyone knows what the box holds.
    secure.get('/api/labels/:id', async (req, reply) => {
      const id = String(req.params.id).toUpperCase();
      if (!ID.test(id)) return reply.code(400).send({ error: 'not a Concordance label' });

      const box = await readBox(id);
      if (box) return { id, claimed: true, box };

      const { rows } = await query('select id from labels where id = $1', [id]);
      return { id, claimed: false, printed: rows.length > 0 };
    });

    secure.put('/api/boxes/:id', async (req, reply) => {
      const id = String(req.params.id).toUpperCase();
      if (!ID.test(id)) return reply.code(400).send({ error: 'not a Concordance label' });

      const name = clean(req.body?.name, 200);
      const location = clean(req.body?.location, 200);
      const notes = clean(req.body?.notes, 2000);
      const items = (Array.isArray(req.body?.items) ? req.body.items : [])
        .map((d) => clean(d, 500))
        .filter(Boolean)
        .slice(0, 200);

      const { prefix, suffix } = splitId(id);
      const client = await pool.connect();
      try {
        await client.query('begin');
        // A label scanned off a sheet that was never imported still resolves.
        await client.query(
          `insert into labels (id, prefix, suffix) values ($1, $2, $3)
           on conflict (id) do nothing`,
          [id, prefix, suffix]
        );
        await client.query(
          `insert into boxes (label_id, name, location, notes)
           values ($1, $2, $3, $4)
           on conflict (label_id) do update
             set name = excluded.name, location = excluded.location,
                 notes = excluded.notes, updated_at = now()`,
          [id, name, location, notes]
        );
        // Items are replaced wholesale. The list is short and the client always
        // sends the full set, so diffing would add failure modes for nothing.
        await client.query('delete from items where label_id = $1', [id]);
        for (const [i, description] of items.entries()) {
          await client.query(
            'insert into items (label_id, description, position) values ($1, $2, $3)',
            [id, description, i]
          );
        }
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }

      return { id, claimed: true, box: await readBox(id) };
    });

    secure.delete('/api/boxes/:id', async (req, reply) => {
      const id = String(req.params.id).toUpperCase();
      const { rowCount } = await query('delete from boxes where label_id = $1', [id]);
      if (!rowCount) return reply.code(404).send({ error: 'no such box' });
      return { id, claimed: false };
    });

    secure.get('/api/boxes', async (req) => {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
      const { rows } = await query(
        `select b.label_id, b.name, b.location, b.updated_at,
                (select count(*) from items i where i.label_id = b.label_id)::int as item_count
           from boxes b order by b.updated_at desc limit $1`,
        [limit]
      );
      return { boxes: rows };
    });

    // "Which box has the ski boots." Ranked over item descriptions and the
    // box's own fields, with a prefix match so partial words work while typing.
    secure.get('/api/search', async (req) => {
      const q = clean(req.query.q, 200);
      if (!q) return { query: '', results: [] };

      const tsquery = q.split(/\s+/).filter(Boolean)
        .map((w) => w.replace(/[^\w]/g, '')).filter(Boolean)
        .map((w) => `${w}:*`).join(' & ');
      if (!tsquery) return { query: q, results: [] };

      const { rows } = await query(
        `select b.label_id, b.name, b.location, b.updated_at,
                ts_rank(s.document, to_tsquery('english', $1)) as rank,
                coalesce((select json_agg(i.description order by i.position, i.id)
                          from items i where i.label_id = b.label_id), '[]') as items
           from box_search s
           join boxes b on b.label_id = s.label_id
          where s.document @@ to_tsquery('english', $1)
          order by rank desc, b.updated_at desc
          limit 50`,
        [tsquery]
      );
      return { query: q, results: rows };
    });

    // Seed from a Quire manifest, so a freshly printed sheet is known here
    // before anyone sticks a label on anything.
    secure.post('/api/labels/import', async (req, reply) => {
      const incoming = Array.isArray(req.body?.labels) ? req.body.labels : null;
      if (!incoming) return reply.code(400).send({ error: 'expected a Quire manifest with a labels array' });

      let imported = 0, skipped = 0;
      for (const entry of incoming.slice(0, 5000)) {
        const id = String(entry?.id ?? '').toUpperCase();
        if (!ID.test(id)) { skipped++; continue; }
        const { prefix, suffix } = splitId(id);
        const { rowCount } = await query(
          `insert into labels (id, prefix, suffix) values ($1, $2, $3)
           on conflict (id) do nothing`,
          [id, prefix, suffix]
        );
        imported += rowCount;
      }
      const { rows } = await query('select count(*)::int as total from labels');
      return { imported, skipped, total: rows[0].total };
    });

    // Printed but never stuck on anything -- what is still blank in the drawer.
    secure.get('/api/labels/unclaimed', async () => {
      const { rows } = await query(
        `select l.id, l.created_at from labels l
          where not exists (select 1 from boxes b where b.label_id = l.id)
          order by l.created_at desc, l.id limit 500`
      );
      return { labels: rows };
    });
  });
}
