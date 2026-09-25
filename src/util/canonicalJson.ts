/**
 * Canonical JSON: one byte-exact serialization of a JSON value, so two
 * implementations can hash or sign "the same value" and agree on the bytes.
 * Byte-identical with the agent's Go canonicalizer
 * (internal/connector/moduleresponsesig.go); the shared vectors in
 * test/vectors/response_signing_vectors.json (identical to the agent's
 * testdata copy) lock both.
 *
 *   null | boolean  -> "null" | "true" | "false"
 *   number          -> the ECMAScript JSON number token (JSON.stringify). The
 *                      agent receives this exact token over the socket
 *                      (json.Number) and re-emits it verbatim, so both anchor to
 *                      one serialization of the value — no reformatting either
 *                      side. Non-finite numbers are rejected.
 *   string          -> '"' + RFC 8785 minimal escaping + '"'; every other code
 *                      point (incl. non-ASCII) is literal UTF-8.
 *   array           -> "[" + elements joined by "," + "]"   (no whitespace)
 *   object          -> keys ascending by UTF-8 byte order,
 *                      "{" + '"k":v' joined by "," + "}"     (no whitespace)
 *
 * Used for the module response-signing string (rpc/responseSigning.ts) and the
 * content digest of an actor upsert (procedures/upsertShared.ts).
 */

/** RFC 8785 minimal string escaping; all other code points literal UTF-8. */
function canonicalString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (cp === 0x08) out += "\\b";
    else if (cp === 0x09) out += "\\t";
    else if (cp === 0x0a) out += "\\n";
    else if (cp === 0x0c) out += "\\f";
    else if (cp === 0x0d) out += "\\r";
    else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

const utf8 = new TextEncoder();

/** Compare two strings by their UTF-8 byte sequences (matches Go sort.Strings). */
function compareUtf8(a: string, b: string): number {
  const ea = utf8.encode(a);
  const eb = utf8.encode(b);
  const n = Math.min(ea.length, eb.length);
  for (let i = 0; i < n; i++) {
    if (ea[i] !== eb[i]) return ea[i] - eb[i];
  }
  return ea.length - eb.length;
}

/** Serialize a JSON value to its canonical string form (see file header). */
export function canonicalize(v: unknown): string {
  if (v === null || v === undefined) return "null";
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(v))
      throw new Error("cannot canonicalize non-finite number");
    return JSON.stringify(v);
  }
  if (t === "string") return canonicalString(v as string);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  if (t === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort(compareUtf8);
    return (
      "{" +
      keys
        .map((k) => canonicalString(k) + ":" + canonicalize(obj[k]))
        .join(",") +
      "}"
    );
  }
  throw new Error("cannot canonicalize value of type " + t);
}
