/**
 * RFC 3986 compliant percent-encoding for URI path segments
 * (https://datatracker.ietf.org/doc/html/rfc3986#section-3.3).
 *
 * @param input - Raw string to encode.
 * @param encodeSlash - When true also encodes forward slashes.
 */
export function uriEncode(input: string, encodeSlash?: boolean): string {
  const encoded = encodeURIComponent(input)
    .replace(/[!'()*]/g, (char) => {
      const code = char.codePointAt(0);
      return code === undefined ? "" : `%${code.toString(16).toUpperCase()}`;
    })
    .replace(/%7E/g, "~");
  if (!encodeSlash) {
    return encoded.replace(/%2F/g, "/");
  }
  return encoded;
}

/**
 * Serializes query parameters under the same RFC 3986 rules SigV4 canonicalizes
 * them with, so that a signed query and a sent query can be the same bytes.
 *
 * `URLSearchParams.toString()` cannot be used for this: it serializes
 * `application/x-www-form-urlencoded`, where a space is `+`, a tilde is `%7E`
 * and a star is bare. Each of those three is a disagreement with the canonical
 * form, and each is a `SignatureDoesNotMatch` from a store that recomputes the
 * canonical request — which AWS does.
 *
 * @param entries - Key/value pairs, emitted in the order they are iterated.
 */
export function encodeQueryString(entries: Iterable<readonly [string, string]>): string {
  const parts: string[] = [];
  for (const [key, value] of entries) {
    parts.push(`${uriEncode(key, true)}=${uriEncode(value, true)}`);
  }
  return parts.join("&");
}
