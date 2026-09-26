// The version this Worker advertises on its unauthenticated health surfaces.
//
// WHY THIS FILE EXISTS: a green deploy workflow proves the UPLOAD succeeded, not that the
// running Worker is the code you think it is. Without a version on the wire, "is the fix
// actually serving?" is answerable only with an account-scoped Cloudflare token, from a
// system separate from the one serving traffic (fleet-chezmoi#1641).
//
// WHY A GUARDED LITERAL AND NOT `import pkg from "../package.json"`: importing package.json
// would bundle the dependency list into a Worker whose whole point here is to disclose one
// short string, and it would put the manifest on the deployed surface. The literal is a copy
// -- but it is a copy that CANNOT SHIP WRONG, because tests/version.test.ts reads package.json
// off disk and derives the expected value from it rather than carrying a second hand-typed
// copy of the same string.
//
// That distinction is the entire point. In prism-mcp the advertised version was a literal and
// the test asserting it carried a TRANSCRIBED duplicate, so the assertion only ever proved
// that someone had typed the same thing twice, and a correct version bump went red.
export const VERSION = "1.0.5";
