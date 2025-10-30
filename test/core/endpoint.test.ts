import { describe, expect, it } from "vitest";

import { buildRequestUrl, encodeS3Key } from "../../src/core/endpoint";

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
});
