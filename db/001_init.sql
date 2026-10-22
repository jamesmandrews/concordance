-- A label is an identifier Quire minted and printed. It exists the moment the
-- sheet comes out of the printer, before anyone knows what the box holds.
create table labels (
  id         text primary key,
  prefix     text,
  suffix     text not null,
  created_at timestamptz not null default now()
);

-- A box is what the label was eventually stuck to. Separate from labels so an
-- unclaimed label is representable: printed, stuck on nothing yet.
create table boxes (
  label_id   text primary key references labels(id) on delete cascade,
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
  label_id    text not null references labels(id) on delete cascade,
  description text not null,
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);

create index items_label_id_idx on items (label_id);
create index boxes_updated_at_idx on boxes (updated_at desc);

-- Search document per box: its own fields plus every item description.
-- Computed per query rather than materialised, which is the right trade at
-- household scale. If this ever gets slow, make it a materialised view with a
-- refresh trigger -- the query below does not have to change.
create view box_search as
select
  b.label_id,
  setweight(to_tsvector('english', b.name), 'A') ||
  setweight(to_tsvector('english', coalesce(
    (select string_agg(i.description, ' ') from items i where i.label_id = b.label_id), '')), 'A') ||
  setweight(to_tsvector('english', b.location), 'B') ||
  setweight(to_tsvector('english', b.notes), 'C') as document
from boxes b;
