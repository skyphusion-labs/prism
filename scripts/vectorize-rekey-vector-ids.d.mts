// Types for scripts/vectorize-rekey-vector-ids.mjs, so the node test suite typechecks against it.
export interface RekeyOptions {
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
export interface LegacyRow {
  rowId: number;
  vectorId: string;
}
export interface RekeyApi {
  census(d1: string): Promise<{ total: number; legacy: number }>;
  legacyRows(d1: string): Promise<LegacyRow[]>;
  repoint(d1: string, rowId: number, oldId: string, newId: string): Promise<number>;
  getByIds(index: string, ids: string[]): Promise<Vec[]>;
  upsert(index: string, vectors: Vec[]): Promise<void>;
  deleteByIds(index: string, ids: string[]): Promise<void>;
}
export interface RekeyCounts {
  d1_total: number;
  legacy: number;
  fetched: number;
  rekeyed: number;
  old_deleted: number;
  gaps: number;
  conflicts: number;
}
export function mintVectorId(): string;
export function isEmailBearingId(id: string): boolean;
export function parseArgs(argv: string[]): RekeyOptions;
export function client(args: { token: string; accountId: string; fetchImpl?: typeof fetch }): RekeyApi;
export function rekey(
  api: RekeyApi,
  opts: RekeyOptions & { mint?: () => string },
): Promise<{ code: 0 | 1 | 2; counts: RekeyCounts; refusal: string | null }>;
