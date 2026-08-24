import { describe, expect, it } from "vitest";

import { applyQuery, createHeaders, finalizeQuery } from "../../src/core.ts";

describe("serializer helpers", () => {
  it("merges headers and metadata", () => {
    const headers = createHeaders({
      headers: { "x-custom": "value" },
      contentType: "text/plain",
    });

    expect(headers.get("content-type")).toBe("text/plain");
    expect(headers.get("x-custom")).toBe("value");
  });

  it("applies query parameters including arrays", () => {
    const url = new URL("https://example.com");
    applyQuery(url, {
      "prefix": "photos/",
      "max-keys": 100,
      "marker": ["a", "b"],
      "active": true,
    });

    expect(url.searchParams.getAll("marker")).toEqual(["a", "b"]);
    expect(url.searchParams.get("prefix")).toBe("photos/");
    expect(url.searchParams.get("max-keys")).toBe("100");
    expect(url.searchParams.get("active")).toBe("true");
  });

  /*
   * Two encoders used to disagree about the same request. SigV4 canonicalises
   * the query with RFC 3986 rules — a space is `%20`, a tilde is a tilde, a star
   * is `%2A` — while the URL that was actually sent came out of
   * `URLSearchParams`, which serialises `application/x-www-form-urlencoded`: a
   * space is `+`, a tilde is `%7E`, a star is bare. The signature therefore
   * covered a query the server never received, and a store that recomputes the
   * canonical request byte for byte (AWS does) answers `SignatureDoesNotMatch`.
   *
   * `finalizeQuery` is the reconciliation: the wire gets the signer's encoding,
   * in the order the parameters were added, and the decoded pairs are untouched
   * so what the signer sees is what the socket carries.
   */
  it("re-encodes the query the way SigV4 signs it", () => {
    const url = new URL("https://example.com/bucket");
    applyQuery(url, {
      "prefix": "my folder/",
      "tilde": "~x",
      "star": "*x",
      "plus": "a+b",
      "max-keys": 100,
    });

    finalizeQuery(url);

    expect(url.search).toBe("?prefix=my%20folder%2F&tilde=~x&star=%2Ax&plus=a%2Bb&max-keys=100");
    /* The `+` of form encoding is the whole bug; a literal one survives as `%2B`. */
    expect(url.search.replace(/%2B/g, "")).not.toContain("+");
    /* Re-encoding is not re-interpreting: every value still reads back as itself. */
    expect(url.searchParams.get("prefix")).toBe("my folder/");
    expect(url.searchParams.get("plus")).toBe("a+b");
  });

  it("leaves a query-less URL query-less", () => {
    const url = new URL("https://example.com/bucket/key.txt");
    finalizeQuery(url);
    expect(url.toString()).toBe("https://example.com/bucket/key.txt");
  });
});
