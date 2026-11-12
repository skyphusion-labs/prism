// Vectorize vector ids for RAG chunks (prism#232).
//
// A vector id is visible outside D1: in the Vectorize index, in query results, and in any tool
// that lists or exports ids. So an id must not carry who owns the vector. Before prism#232 the
// id was `${userEmail}:${docId}:${chunkIndex}`, which put the raw email into every id in access
// mode. Ownership is carried by the vector's `user_email` metadata (retrieval filters on it) and
// by the D1 `chunks` row, never by the id.
//
// The new id is random: `c_` plus 32 hex digits from crypto.randomUUID(). It is 34 bytes, well
// under the Vectorize id limit, and it is stored in `chunks.vector_id`, which every reader
// (retrieval join, document delete, account delete) already uses as the source of truth. So
// old-format ids keep working without any change on the read side.

/** Prefix of every vector id minted after prism#232. */
export const VECTOR_ID_PREFIX = "c_";

const NEW_FORMAT = /^c_[0-9a-f]{32}$/;

/** Mint a fresh, non-identifying vector id. */
export function mintVectorId(): string {
  return VECTOR_ID_PREFIX + crypto.randomUUID().replace(/-/g, "");
}

/** True for an id in the post-prism#232 random format. */
export function isOpaqueVectorId(id: string): boolean {
  return NEW_FORMAT.test(id);
}
