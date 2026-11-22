import { createHash, createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { S3Client } from "../src/index.ts";
import { SigningKeyCache, presignUrl, sharedSigningKeyCache, signRequest } from "../src/signer.ts";
import type { Credentials } from "../src/types.ts";

const credentials: Credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

describe("signer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2023-01-02T03:04:05Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the URL it signed, with the query encoded as it was signed", async () => {
    /* `URLSearchParams` writes a space as `+` and a tilde as `%7E`, which SigV4 does not sign. */
    const url = new URL("https://my-bucket.s3.us-east-1.amazonaws.com/a.txt");
    url.searchParams.set("note", "a b~");

    const result = await signRequest({ method: "GET", url, credentials, region: "us-east-1" });

    expect(result.url.search).toBe("?note=a%20b~");
    expect(url.search).toBe("?note=a+b%7E");
  });

  it("produces deterministic authorization headers", async () => {
    const url = new URL("https://my-bucket.s3.us-east-1.amazonaws.com/test.txt");

    const result = await signRequest({
      method: "GET",
      url,
      credentials,
      region: "us-east-1",
      unsignedPayload: true,
    });

    const auth = result.headers.get("authorization");
    expect(auth).toBeTruthy();

    const canonicalHeaders = [
      `host:${url.host}`,
      `x-amz-content-sha256:${result.payloadHash}`,
      `x-amz-date:${result.amzDate}`,
    ]
      .sort()
      .join("\n");
    const canonicalRequest = [
      "GET",
      url.pathname,
      url.searchParams.toString(),
      `${canonicalHeaders}\n`,
      result.signedHeaders,
      result.payloadHash,
    ].join("\n");

    const canonicalHash = createHash("sha256").update(canonicalRequest, "utf8").digest("hex");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      result.amzDate,
      `20230102/us-east-1/s3/aws4_request`,
      canonicalHash,
    ].join("\n");

    const signingKey = deriveSigningKey(credentials.secretAccessKey, "20230102", "us-east-1", "s3");
    const expectedSignature = createHmac("sha256", signingKey)
      .update(stringToSign, "utf8")
      .digest("hex");

    expect(auth).toBe(
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/20230102/us-east-1/s3/aws4_request, SignedHeaders=${result.signedHeaders}, Signature=${expectedSignature}`,
    );
  });

  it("presigns URLs with stable signature", async () => {
    const url = new URL("https://my-bucket.s3.us-east-1.amazonaws.com/test.txt");

    const { url: presigned } = await presignUrl({
      method: "GET",
      url,
      credentials,
      region: "us-east-1",
      expiresInSeconds: 900,
    });

    const parsed = presigned;
    const params = parsed.searchParams;
    expect(params.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    const credential = params.get("X-Amz-Credential");
    expect(credential).toBe(`${credentials.accessKeyId}/20230102/us-east-1/s3/aws4_request`);
    const signature = params.get("X-Amz-Signature");
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 604_801])(
    "refuses an expiry of %s seconds",
    async (expiresInSeconds) => {
      const url = new URL("https://my-bucket.s3.us-east-1.amazonaws.com/test.txt");

      await expect(
        presignUrl({ method: "GET", url, credentials, region: "us-east-1", expiresInSeconds }),
      ).rejects.toThrow(RangeError);
    },
  );

  it.each([1, 604_800])("accepts an expiry of %s seconds", async (expiresInSeconds) => {
    const url = new URL("https://my-bucket.s3.us-east-1.amazonaws.com/test.txt");

    const { url: presigned } = await presignUrl({
      method: "GET",
      url,
      credentials,
      region: "us-east-1",
      expiresInSeconds,
    });

    expect(presigned.searchParams.get("X-Amz-Expires")).toBe(String(expiresInSeconds));
  });

  it("handles keys with special characters without double-encoding", async () => {
    // Test with a key containing spaces
    const url = new URL("https://my-bucket.s3.us-east-1.amazonaws.com/my%20file%20name.txt");

    const result = await signRequest({
      method: "GET",
      url,
      credentials,
      region: "us-east-1",
      unsignedPayload: true,
    });

    const auth = result.headers.get("authorization");
    expect(auth).toBeTruthy();

    expect(auth).toMatch(/^AWS4-HMAC-SHA256/);

    // Also test presigned URL with special characters
    const { url: presigned } = await presignUrl({
      method: "GET",
      url,
      credentials,
      region: "us-east-1",
      expiresInSeconds: 900,
    });

    const signature = presigned.searchParams.get("X-Amz-Signature");
    expect(signature).toMatch(/^[a-f0-9]{64}$/);

    // Verify the URL pathname is correctly encoded (single encoding, not double)
    expect(presigned.pathname).toBe("/my%20file%20name.txt");
  });
});

/*
 * Derived signing keys are kept in a `SigningKeyCache`, so a request costs one
 * HMAC instead of five. A cache is an object the application places: one per
 * tenant, per department, per request, or none at all. Every test below signs
 * through a cache of its own, so no test is answered by another's keys.
 */
describe("signing key caches", () => {
  const url = new URL("https://my-bucket.s3.amazonaws.com/test.txt");
  const day = new Date("2024-06-07T08:09:10Z");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const sign = async (
    signingKeyCache: SigningKeyCache | false,
    accessKeyId = "AKIDCACHE",
    secretAccessKey = `secret-${accessKeyId}`,
    { region = "caches", datetime = day } = {},
  ): Promise<string> => {
    const result = await signRequest({
      method: "GET",
      url,
      credentials: { accessKeyId, secretAccessKey },
      region,
      datetime,
      unsignedPayload: true,
      signingKeyCache,
    });
    return result.headers.get("authorization")!;
  };

  /** The signature an independent implementation computes for the same request. */
  const expected = (secret: string, region: string): string => {
    const canonical = [
      "GET",
      "/test.txt",
      "",
      `host:${url.host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:20240607T080910Z\n`,
      "host;x-amz-content-sha256;x-amz-date",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      "20240607T080910Z",
      `20240607/${region}/s3/aws4_request`,
      createHash("sha256").update(canonical, "utf8").digest("hex"),
    ].join("\n");
    return createHmac("sha256", deriveSigningKey(secret, "20240607", region, "s3"))
      .update(stringToSign, "utf8")
      .digest("hex");
  };

  const signatureOf = (authorization: string): string =>
    /Signature=([\da-f]+)/.exec(authorization)![1]!;

  it("derives a key once per day and region", async () => {
    const cache = new SigningKeyCache();
    await sign(cache);
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    await sign(cache, undefined, undefined, { datetime: new Date("2024-06-07T23:59:59Z") });
    expect(importKey).not.toHaveBeenCalled();

    await sign(cache, undefined, undefined, { datetime: new Date("2024-06-08T00:00:00Z") });
    expect(importKey).toHaveBeenCalled();

    importKey.mockClear();
    await sign(cache, undefined, undefined, { region: "elsewhere" });
    expect(importKey).toHaveBeenCalled();
  });

  it("shares one derivation between concurrent requests", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    await sign(new SigningKeyCache());
    const once = importKey.mock.calls.length;
    expect(once).toBeGreaterThan(0);
    importKey.mockClear();

    const cache = new SigningKeyCache();
    const [first, second] = await Promise.all([sign(cache), sign(cache)]);

    expect(first).toBe(second);
    expect(importKey).toHaveBeenCalledTimes(once);
  });

  it("keeps a key per secret, so a shared access key id never thrashes", async () => {
    const cache = new SigningKeyCache();
    await sign(cache, "minioadmin", "secret-one");
    await sign(cache, "minioadmin", "secret-two");
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    const one = await sign(cache, "minioadmin", "secret-one");
    const two = await sign(cache, "minioadmin", "secret-two");

    expect(importKey).not.toHaveBeenCalled();
    expect(signatureOf(one)).toBe(expected("secret-one", "caches"));
    expect(signatureOf(two)).toBe(expected("secret-two", "caches"));
  });

  it("never mistakes one credential for another, whatever their characters", async () => {
    const cache = new SigningKeyCache();
    await sign(cache, "A/20240607", "same-secret", { region: "eu" });

    const other = await sign(cache, "A", "same-secret", { region: "20240607/eu" });

    expect(signatureOf(other)).toBe(expected("same-secret", "20240607/eu"));
  });

  it("does not cache a derivation that failed", async () => {
    const cache = new SigningKeyCache();
    vi.spyOn(crypto.subtle, "importKey").mockRejectedValueOnce(new Error("no crypto today"));

    await expect(sign(cache)).rejects.toThrow("no crypto today");
    const signed = await sign(cache);

    expect(signatureOf(signed)).toBe(expected("secret-AKIDCACHE", "caches"));
  });

  it("lets a late failure of a cleared derivation leave its successor alone", async () => {
    const cache = new SigningKeyCache();
    let fail!: (error: Error) => void;
    vi.spyOn(crypto.subtle, "importKey").mockImplementationOnce(
      () => new Promise<CryptoKey>((_, reject) => (fail = reject)),
    );

    const pending = cache.signingKey(credentials, "20240607", "caches");
    await vi.waitFor(() => expect(fail).toBeDefined());
    cache.clear();
    await cache.signingKey(credentials, "20240607", "caches");
    fail(new Error("too late"));
    await expect(pending).rejects.toThrow("too late");

    vi.restoreAllMocks();
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    await cache.signingKey(credentials, "20240607", "caches");
    expect(importKey).not.toHaveBeenCalled();
  });

  it("evicts the least recently used key once full", async () => {
    const cache = new SigningKeyCache({ size: 2 });
    await sign(cache, "AKIDA");
    await sign(cache, "AKIDB");
    await sign(cache, "AKIDA");
    await sign(cache, "AKIDC");
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    await sign(cache, "AKIDA");
    await sign(cache, "AKIDC");
    expect(importKey).not.toHaveBeenCalled();

    await sign(cache, "AKIDB");
    expect(importKey).toHaveBeenCalled();
  });

  it("holds sixteen keys by default", async () => {
    const cache = new SigningKeyCache();
    for (let index = 0; index < 16; index += 1) await sign(cache, `AKID${index}`);
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    await sign(cache, "AKID0");
    expect(importKey).not.toHaveBeenCalled();

    await sign(cache, "AKID16");
    importKey.mockClear();
    await sign(cache, "AKID1");
    expect(importKey).toHaveBeenCalled();
  });

  it("forgets an access key on every day and region, or every key at once", async () => {
    const cache = new SigningKeyCache();
    const later = { region: "elsewhere", datetime: new Date("2024-06-09T00:00:00Z") };
    await sign(cache, "AKIDKEEP");
    await sign(cache, "AKIDDROP");
    await sign(cache, "AKIDDROP", undefined, later);
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    cache.delete("AKIDDROP");
    await sign(cache, "AKIDKEEP");
    expect(importKey).not.toHaveBeenCalled();
    await sign(cache, "AKIDDROP");
    expect(importKey).toHaveBeenCalled();
    importKey.mockClear();
    await sign(cache, "AKIDDROP", undefined, later);
    expect(importKey).toHaveBeenCalled();

    importKey.mockClear();
    cache.clear();
    await sign(cache, "AKIDKEEP");
    expect(importKey).toHaveBeenCalled();
  });

  it("derives a fresh key on every request without a cache", async () => {
    await sign(false);
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    await sign(false);

    expect(importKey).toHaveBeenCalled();
  });

  it("signs through the shared cache by default, which the application can clear", async () => {
    const input = {
      method: "GET",
      url,
      credentials,
      region: "shared",
      unsignedPayload: true,
    } as const;
    await signRequest(input);
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    await signRequest(input);
    expect(importKey).not.toHaveBeenCalled();

    sharedSigningKeyCache.clear();
    await signRequest(input);
    expect(importKey).toHaveBeenCalled();
  });

  it("works with a cache from another copy of the module", async () => {
    /* What two installed copies of uns3 amount to: a cache this module did not create. */
    const foreign = new SigningKeyCache();
    const lookalike = {
      signingKey: foreign.signingKey.bind(foreign),
      delete: foreign.delete.bind(foreign),
      clear: foreign.clear.bind(foreign),
    } as unknown as SigningKeyCache;

    const signed = await sign(lookalike);

    expect(signatureOf(signed)).toBe(expected("secret-AKIDCACHE", "caches"));
  });

  it("refuses what is not a cache, up front", async () => {
    const endpoint = "https://s3.amazonaws.com";
    // @ts-expect-error a Map holds no signing keys
    expect(() => new S3Client({ endpoint, signingKeyCache: new Map() })).toThrow(TypeError);
    // @ts-expect-error true is not a cache
    expect(() => new S3Client({ endpoint, signingKeyCache: true })).toThrow(TypeError);
    await expect(sign({} as SigningKeyCache)).rejects.toThrow(TypeError);
  });

  it("refuses credentials without a secret rather than signing with nothing", async () => {
    const cache = new SigningKeyCache();

    await expect(sign(cache, "AKIDBAD", null as never)).rejects.toThrow(TypeError);
    await expect(sign(false, "AKIDBAD", null as never)).rejects.toThrow(TypeError);

    cache.delete("AKIDBAD");
    expect(signatureOf(await sign(cache))).toBe(expected("secret-AKIDCACHE", "caches"));
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses a size of %s", (size) => {
    expect(() => new SigningKeyCache({ size })).toThrow(RangeError);
  });

  it.each([8, "4", null])("refuses %j in place of the options object", (options) => {
    expect(() => new SigningKeyCache(options as never)).toThrow(TypeError);
  });

  it("is the cache a client signs and presigns with", async () => {
    const cache = new SigningKeyCache();
    const client = new S3Client({
      endpoint: "https://s3.amazonaws.com",
      region: "client-cache",
      credentials: { accessKeyId: "AKIDCLIENT", secretAccessKey: "secret" },
      signingKeyCache: cache,
      fetch: (async () => new Response("ok")) as typeof fetch,
    });
    await client.get({ bucket: "my-bucket", key: "a.txt" });
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    await client.getSignedUrl({ method: "GET", bucket: "my-bucket", key: "a.txt" });
    expect(importKey).not.toHaveBeenCalled();

    cache.clear();
    await client.get({ bucket: "my-bucket", key: "a.txt" });
    expect(importKey).toHaveBeenCalled();
  });

  it("derives on every request of a client told to keep no cache", async () => {
    const client = new S3Client({
      endpoint: "https://s3.amazonaws.com",
      region: "client-cache",
      credentials: { accessKeyId: "AKIDNOCACHE", secretAccessKey: "secret" },
      signingKeyCache: false,
      fetch: (async () => new Response("ok")) as typeof fetch,
    });
    await client.get({ bucket: "my-bucket", key: "a.txt" });
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    await client.get({ bucket: "my-bucket", key: "a.txt" });

    expect(importKey).toHaveBeenCalled();
  });

  it("knows the hash of an empty payload without computing it", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");

    const result = await signRequest({
      method: "DELETE",
      url,
      credentials,
      region: "us-east-1",
      signingKeyCache: new SigningKeyCache(),
    });

    expect(result.payloadHash).toBe(createHash("sha256").update("").digest("hex"));
    /* Only the canonical request is hashed. */
    expect(digest).toHaveBeenCalledTimes(1);
  });
});

function deriveSigningKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = createHmac("sha256", `AWS4${secret}`).update(date, "utf8").digest();
  const kRegion = createHmac("sha256", kDate).update(region, "utf8").digest();
  const kService = createHmac("sha256", kRegion).update(service, "utf8").digest();
  return createHmac("sha256", kService).update("aws4_request", "utf8").digest();
}
