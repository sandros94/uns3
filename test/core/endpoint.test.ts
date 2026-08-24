import { describe, expect, it } from "vitest";

import { buildRequestUrl, encodeS3Key } from "../../src/core.ts";

describe("endpoint builder", () => {
  it("uses virtual-hosted style by default", () => {
    const url = buildRequestUrl({
      endpoint: "https://s3.us-west-2.amazonaws.com",
      bucketStyle: "virtual",
      bucket: "my-bucket",
      key: "path/to/object.txt",
    });

    expect(url.hostname).toBe("my-bucket.s3.us-west-2.amazonaws.com");
    expect(url.pathname).toBe("/path/to/object.txt");
  });

  it("supports custom endpoint with path-style", () => {
    const url = buildRequestUrl({
      endpoint: "https://storage.example.com/base",
      bucketStyle: "path",
      bucket: "archive",
      key: "nested/file.json",
    });

    expect(url.hostname).toBe("storage.example.com");
    expect(url.pathname).toBe("/base/archive/nested/file.json");
  });

  it("encodes keys, also according to RFC 3986", () => {
    expect(encodeS3Key("space key.txt")).toBe("space%20key.txt");
    expect(encodeS3Key("ümlaut/✓.txt")).toBe("%C3%BCmlaut/%E2%9C%93.txt");
    expect(encodeS3Key("a+b.txt")).toBe("a%2Bb.txt");

    // Reserved characters are encoded while path separators are preserved
    expect(encodeS3Key("colon:and/slash/")).toBe("colon%3Aand/slash/");
  });

  it("falls back to path-style when bucket is not DNS-compliant", () => {
    const url = buildRequestUrl({
      endpoint: "https://s3.amazonaws.com",
      bucketStyle: "virtual",
      bucket: "My_Bucket",
      key: "object.txt",
    });

    expect(url.hostname).toBe("s3.amazonaws.com");
    expect(url.pathname).toBe("/My_Bucket/object.txt");
  });

  it("uses path-style addressing for IP-based endpoints", () => {
    const url = buildRequestUrl({
      endpoint: "http://127.0.0.1:9000",
      bucketStyle: "virtual",
      bucket: "my-bucket",
      key: "photos/img.jpg",
    });

    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).toBe("9000");
    expect(url.pathname).toBe("/my-bucket/photos/img.jpg");
  });

  it("should handle keys with leading slashes", () => {
    const url = buildRequestUrl({
      endpoint: "https://s3.amazonaws.com",
      bucketStyle: "virtual",
      bucket: "my-bucket",
      key: "/leading/slash.txt",
    });

    expect(url.hostname).toBe("my-bucket.s3.amazonaws.com");
    expect(url.pathname).toBe("/leading/slash.txt");
  });

  /*
   * A key is bytes, and `dir/../evil.txt` is a perfectly legal one: S3's key
   * space is flat, so those three characters are part of the name rather than a
   * step up a tree. A URL's path is not flat, and every WHATWG parser — which is
   * every `URL`, every `Request`, and therefore every `fetch` — removes dot
   * segments while parsing. The key used to be handed to `base.pathname` and
   * came back out shorter: `dir/../evil.txt` was silently stored as `evil.txt`,
   * and `users/a/../b/x` silently escaped the `users/a/` prefix it was scoped to.
   *
   * Percent-encoding does not save it. The spec counts `%2e` and `%2E` as dots
   * for exactly this purpose, so `%2E%2E` is removed as eagerly as `..` is —
   * verified against Node's parser, not assumed. There is no spelling of a
   * dot segment that survives a URL, which means a fetch-based client cannot put
   * one on the wire at all. So it says so, loudly, instead of writing somewhere
   * the caller did not ask for.
   */
  it("refuses keys whose dot segments a URL would normalize away", () => {
    expect(() => encodeS3Key("dir/../evil.txt")).toThrow(/dot segment/i);
    expect(() => encodeS3Key("users/a/../b/x")).toThrow(/dot segment/i);
    expect(() => encodeS3Key("a/./b")).toThrow(/dot segment/i);
    expect(() => encodeS3Key("..")).toThrow(/dot segment/i);
    expect(() => encodeS3Key(".")).toThrow(/dot segment/i);
    /* The leading slash is stripped first, so this is `../a` by the time it is judged. */
    expect(() => encodeS3Key("/../a")).toThrow(/dot segment/i);
    expect(() => encodeS3Key("a/..")).toThrow(/dot segment/i);

    expect(() =>
      buildRequestUrl({
        endpoint: "https://s3.amazonaws.com",
        bucketStyle: "path",
        bucket: "my-bucket",
        key: "dir/../evil.txt",
      }),
    ).toThrow(/dot segment/i);
  });

  it("leaves dots that are part of a name alone", () => {
    /* Only a WHOLE segment of one or two dots is a dot segment. Everything else
       is a name that happens to contain dots, and names are none of our business. */
    expect(encodeS3Key("a.b/c..d")).toBe("a.b/c..d");
    expect(encodeS3Key("...")).toBe("...");
    expect(encodeS3Key("a/..b/c")).toBe("a/..b/c");
    expect(encodeS3Key(".hidden/..config")).toBe(".hidden/..config");
    expect(encodeS3Key("archive.tar.gz")).toBe("archive.tar.gz");
  });
});
