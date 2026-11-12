// URL safety for values this app did not construct.
//
// Web-search rows reach the transcript carrying a `url` field that is
// persisted in retrieved_context and replayed on every later render.
// Current rows use a URL this worker built (src/skyphusion-search.ts).
// Older rows carry a URL from an upstream engine that the worker stored
// after a truthiness check only. Either way the href is replayed from D1,
// so the string is not trusted at render time.
//
// WHY ESCAPING IS THE WRONG TOOL HERE. escapeHtml() replaces & < > " ' and is
// exactly right for stopping attribute injection. It does nothing whatever to
// a scheme: `javascript:alert(1)` contains none of those five characters and
// passes through escaping byte for byte. Escaping answers "can this break out
// of the attribute", and the question an href also has to answer is "what does
// this navigate to". Two different questions, two different guards, and both
// call sites keep both.
//
// PARSE, DO NOT PATTERN-MATCH. The URL parser strips leading and trailing
// C0/space, and removes embedded tab, LF and CR, before it resolves the
// scheme. So " JavaScript:x", "java\nscript:x" and "JAVASCRIPT:x" all
// normalise to protocol "javascript:" and are refused by the check below,
// while a hand-written regex sees three unrelated strings and will miss at
// least one of them. Delegating to the parser is what makes the guard
// complete rather than a list of the variants someone happened to think of.
//
// ALLOWLIST, NOT BLOCKLIST. An allowlist of the two schemes a web result can
// legitimately use cannot be outgrown; a blocklist of the dangerous ones has
// to be extended every time a browser ships a new scheme.
//
// Its own file, loaded as a classic script before app.js, the same shape
// voice-widget.js already uses for shared browser helpers. It is separate so
// that the SHIPPED function is addressable from a test: app.js touches the DOM
// at top level and cannot be evaluated outside a browser, so a guard living
// inside it could only ever be tested by a copy, and a copy is a second thing
// that drifts. tests/public-url-safety.test.ts evaluates THIS file and refuses
// to run at all if the function is missing or renamed, so the suite cannot
// pass vacuously against a guard that is no longer there.
(function () {
  "use strict";

  var ALLOWED_PROTOCOLS = ["http:", "https:"];

  // Returns a value safe to place in an href attribute, or "#" when the input
  // is not a plain web URL.
  //
  // On success it returns the ORIGINAL string rather than the parser's
  // normalised form, so the href and the visible link text next to it stay
  // byte-identical. That is deliberate: a link whose text and destination
  // differ is its own problem, and normalisation would introduce one. The
  // caller still passes the result through escapeHtml, which is what handles
  // a quote inside an otherwise legitimate https URL.
  window.safeHref = function safeHref(raw) {
    if (typeof raw !== "string" || !raw.trim()) return "#";
    var parsed;
    try {
      parsed = new URL(raw);
    } catch (_) {
      // Not an absolute URL. Every caller here passes an absolute one, so a
      // parse failure is a refusal rather than a case to resolve against a
      // base: guessing a base for an unparseable string is how you turn "I do
      // not know what this is" into a confident wrong destination.
      return "#";
    }
    return ALLOWED_PROTOCOLS.indexOf(parsed.protocol) === -1 ? "#" : raw;
  };
})();
