-- AlterTable
-- Internal lineage: which canonical this schema is a projection of. Cited as
-- "name@version" (or bare "name" for the active one), matching how every other
-- consumer references this registry — a loose string, not a foreign key.
ALTER TABLE "Schema" ADD COLUMN "derivesFrom" TEXT;

-- Data fix 1/2: a canonical schema has no external authority.
--
-- `canonical-product` was registered pointing at the Doudian /product/addV2
-- docs, the same URL as the `doudian-addv2` projection. That contradicts what
-- the canonical layer IS: its own description calls it the platform-neutral
-- intermediate shape, and a neutral shape that mirrors one platform's docs is
-- that platform's alias wearing a different name. `upstreamRef` exists to stop
-- a PROJECTION from being silently hand-authored; a canonical is ours to design
-- and is supposed to be hand-authored, so it belongs at null — same as
-- `shop-profile` already is.
--
-- Written against `kind` rather than the one offending row on purpose: the rule
-- is "no canonical has an upstream", so any future row that drifts the same way
-- gets corrected by re-running this reasoning, not by a second one-off patch.
-- The cleared value is recoverable from git history of this file:
--   https://op.jinritemai.com/docs/api-docs/14/249
UPDATE "Schema" SET "upstreamRef" = NULL WHERE "kind" = 'canonical' AND "upstreamRef" IS NOT NULL;

-- Data fix 2/2: record the projection lineage that was previously only
-- inferable from `canonical-product` and `doudian-addv2` sharing entity
-- "product". Scoped to the exact row so a differently-named future projection
-- is not silently claimed to derive from this canonical.
UPDATE "Schema" SET "derivesFrom" = 'canonical-product@1' WHERE "name" = 'doudian-addv2' AND "version" = 1;
