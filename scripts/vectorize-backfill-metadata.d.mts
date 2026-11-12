// Types for scripts/vectorize-backfill-metadata.mjs, so the node test suite typechecks against it.
export const PROPERTY: "user_email";
export interface BackfillOptions {
  index: string;
  d1: string;
  dryRun: boolean;
  batch: number;
}
export interface Vec {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
  namespace?: string;
}
export interface BackfillApi {
  metadataIndexes(index: string): Promise<{ propertyName: string; indexType: string }[]>;
  vectorIds(d1: string): Promise<string[]>;
  getByIds(index: string, ids: string[]): Promise<Vec[]>;
  upsert(index: string, vectors: Vec[]): Promise<void>;
}
export interface BackfillCounts {
  d1_ids: number;
  fetched: number;
  missing_metadata: number;
  upserted: number;
  gaps: number;
}
export function parseArgs(argv: string[]): BackfillOptions;
export function client(args: { token: string; accountId: string; fetchImpl?: typeof fetch }): BackfillApi;
export function hasUserEmailIndex(indexes: { propertyName: string; indexType: string }[]): boolean;
export function backfill(
  api: BackfillApi,
  opts: BackfillOptions & { idsFrom: (api: BackfillApi) => Promise<string[]> },
): Promise<{ code: 0 | 1 | 2; counts: BackfillCounts; refusal: string | null }>;
