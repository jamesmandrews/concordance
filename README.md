# Concordance

Scan a QR label, find out what is in the box.

> A **concordance** maps every term in a text to where it occurs. This one maps
> "ski boots" to `ATTIC-K7M2-9XQZ`.

The companion to [Quire](https://github.com/jamesmandrews/quire), which mints and prints the labels.
Quire is deliberately stateless; Concordance is where the knowledge lives.

## What it does

- **Scan** a label with the phone camera and see what is in that box
- **Claim** a blank label — print first, decide what goes in it later
- **Search** every item, name, location and note at once

Nothing is saved by hand. The box form writes as you type, because the way a
box actually gets filled in — standing over it, one hand holding a phone,
keyboard covering the bottom of the screen — is the way a save button gets
missed. Every edit goes to a draft in `localStorage` first and to the server
on a 600 ms debounce; the draft is dropped only once the server confirms the
exact payload it holds. So a refresh, a locked phone, a swiped-away tab or a
dead connection all end with the typing still there, and it goes up by itself
when the network comes back.

## Stack

PostgreSQL, Node, Docker Compose. No third-party services.

```
your reverse proxy  ──►  api (Node + Fastify)  ──►  db (PostgreSQL 17)
      TLS                 serves the PWA and          internal only,
                          the JSON API                no published port
```

The web app is plain HTML, CSS and JS served by the same Node process, so
there is one origin and no CORS. It is a Progressive Web App — installable to
a home screen, with the shell cached for offline load — but it works as an
ordinary web page too.

## Running it

```sh
cp .env.example .env
# fill in POSTGRES_PASSWORD, SESSION_SECRET and APP_PASSWORD
docker compose up -d --build
```

Migrations run automatically at startup. The app waits for Postgres to accept
connections rather than crash-looping while it boots.

The API binds to **loopback only** (`127.0.0.1:${HOST_PORT}`). Nothing is
exposed to the network until you put a reverse proxy in front of it.

## The camera needs HTTPS

`getUserMedia` only runs in a secure context. Over plain HTTP on a phone the
camera is silently blocked — the app detects this and says so, but the scanner
will not work. `localhost` is exempt, which is why local development is fine.

**TLS is deliberately not in `docker-compose.yml`.** Terminate it in whatever
already fronts your server — nginx, Caddy, Traefik. If you have nothing, add
Caddy as a second container.

### Behind a path prefix

Nothing in the app knows its own mount point. Every asset path is relative,
the API is called at `./api/...`, routing uses the URL hash, and the service
worker and manifest are scoped relatively. Serving it at `/anything` works
with no configuration — provided the proxy **strips the prefix** before
forwarding.

nginx:

```nginx
location /concordance/ {
    proxy_pass http://127.0.0.1:3131/;   # the trailing slash strips the prefix
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
}
```

The app trusts `X-Forwarded-Proto` when deciding whether to mark the session
cookie `Secure`, so pass it or the cookie will not stick over HTTPS.

## Authentication

One shared password for everyone, held in `APP_PASSWORD`. Signing in sets an
HMAC-signed, `httpOnly` session cookie that lasts 30 days.

This is a deliberate first step, not the end state. The pieces that make real
accounts a small change later:

- `boxes.updated_by` already exists and is nullable, so adding accounts is a
  backfill rather than a schema migration
- the session payload is a JSON blob — it grows a user id without touching
  any caller
- every protected route goes through one `requireSession` hook

## Data model

```
boxes   id (the label), prefix, suffix, name, location, notes,
        created_at, updated_at, updated_by
items   id, box_id → boxes, description, position
```

The label ID is the primary key. There is no separate table of printed
labels: an unused label needs no row, because the unused labels are sitting
in the drawer, which is a more reliable record than a database. A box exists
from the moment someone scans its label and says what went in.

Contents are rows rather than a blob of text, which is what makes search a
single query. `box_search` is a view combining the box's own fields with every
item description, weighted so item and name matches outrank a note. It is
computed per query — the right trade at household scale. If it ever gets slow,
make it materialised; the query does not change.

## API

All endpoints except `POST /api/session` require the session cookie.

| | |
|---|---|
| `GET /api/session` | is this browser signed in |
| `POST /api/session` | sign in with `{ password }` |
| `DELETE /api/session` | sign out |
| `GET /api/boxes/:id` | what is in this box, or that it is still empty |
| `PUT /api/boxes/:id` | create or replace a box |
| `DELETE /api/boxes/:id` | clear a box, leaving the label reusable |
| `GET /api/boxes` | every box, most recently changed first |
| `GET /api/search?q=` | ranked full-text search |

IDs are validated against the shape Quire mints, so scanning a product barcode
returns a 400 rather than creating a junk row.

## Development

```sh
npm install
DATABASE_URL=... APP_PASSWORD=... SESSION_SECRET=... npm run dev
```

Needs a Postgres to point at; `docker compose up -d db` is enough.
