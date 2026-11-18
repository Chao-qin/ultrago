-- Book output contract.
--
-- Book.outputSchema: JSON Schema fragment mirrored from the playbook's
-- top-level `outputSchema`. NULL = the book declares no output contract.
--
-- Run.outputsSchemaErrors: JSON array of problems from checking the produced
-- data against that contract. NULL = no contract / not checked, '[]' =
-- conforming, non-empty = violating. Recording only; never fails the run.
--
-- Both nullable with no default, so every existing row keeps meaning exactly
-- what it meant before this migration ("no contract declared").
ALTER TABLE "Book" ADD COLUMN "outputSchema" TEXT;
ALTER TABLE "Run" ADD COLUMN "outputsSchemaErrors" TEXT;
