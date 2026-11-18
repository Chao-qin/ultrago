import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ParamSchemaFragment } from "@bcp/shared";
import { api } from "./api";
import { schemaLookup } from "./flow-ports-client";

/**
 * The one registry-citation resolver for form-side consumers (ParamFields,
 * paramInitialValues).
 *
 * `schemaLookup` needs a fetched registry list, and every consumer used to
 * fetch-or-skip it independently — which is why the book trigger dialog and
 * the schedule dialog silently degraded to a bare JSON textarea: their
 * ParamFields got no resolver, citations never resolved, and the 选存档
 * picker only existed inside FlowEditor. One hook, one shared `["schemas"]`
 * cache entry, every dialog gets the same answer the registry page shows.
 *
 * Returns `undefined` until the list arrives; ParamFields degrades to the
 * plain textarea for that instant and upgrades once resolved.
 */
export function useSchemaResolver():
  | ((ref?: { name: string; version?: number }) => ParamSchemaFragment | null)
  | undefined {
  const schemas = useQuery({ queryKey: ["schemas"], queryFn: () => api.listSchemas() });
  return useMemo(
    () => (schemas.data ? schemaLookup(schemas.data) : undefined),
    [schemas.data],
  );
}
