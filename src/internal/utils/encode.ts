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
