-- A box is a label that someone has written contents against. The label ID is
-- the primary key: Quire minted it, the printer printed it, and it identifies
-- the box for the rest of its life.
--
-- There is deliberately no separate "labels" table. A printed label that is
-- not on a box yet needs no row here -- the unused labels are sitting in the
-- drawer, which is a more reliable record than a database could be. A box
-- comes into existence the first time someone scans its label and says what
-- went in.
create table boxes (
  id         text primary key,
  -- Split out so boxes can be grouped by the prefix Quire printed on them.
  prefix     text,
  suffix     text not null,
  name       text not null default '',
  location   text not null default '',
  notes      text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Nullable until real accounts land. Everyone shares one password today, so
  -- there is nobody to attribute an edit to; adding accounts later is then a
  -- backfill rather than a schema change.
  updated_by text
);

-- Contents as rows, not one blob of text. This is what makes "which box has
-- the ski boots" a single query.
create table items (
  id          bigserial primary key,
  box_id      text not null references boxes(id) on delete cascade,
  description text not null,
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);

create index items_box_id_idx on items (box_id);
create index boxes_updated_at_idx on boxes (updated_at desc);
create index boxes_prefix_idx on boxes (prefix);

-- Search document per box: its own fields plus every item description.
-- Computed per query rather than materialised, which is the right trade at
-- household scale. If this ever gets slow, make it a materialised view with a
-- refresh trigger -- the query against it does not have to change.
create view box_search as
select
  b.id as box_id,
  setweight(to_tsvector('english', b.name), 'A') ||
  setweight(to_tsvector('english', coalesce(
    (select string_agg(i.description, ' ') from items i where i.box_id = b.id), '')), 'A') ||
  setweight(to_tsvector('english', b.location), 'B') ||
  setweight(to_tsvector('english', b.notes), 'C') as document
from boxes b;
