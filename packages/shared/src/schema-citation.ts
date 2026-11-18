/** A schema registry citation pinned to one immutable version. */
export interface SchemaCitation {
  name: string;
  version: number;
}

/** Read-only compatibility shape for graphs written before version pinning. */
export type SchemaCitationInput = Pick<SchemaCitation, "name"> & { version?: number };
