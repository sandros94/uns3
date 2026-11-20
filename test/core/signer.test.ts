import { createHash, createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { presignUrl, signRequest } from "../../src/core.ts";
import type { Credentials } from "../../src/types.ts";

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
 * The signing key depends on the secret, the day and the region alone, so it
 * is derived once and reused: a request then costs one HMAC instead of five.
 * Each test signs for its own region, so the module-level cache one test fills
 * never answers for another.
 */
describe("signing key", () => {
  const url = new URL("https://my-bucket.s3.amazonaws.com/test.txt");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const signed = async (
    region: string,
    datetime: Date,
    secretAccessKey = credentials.secretAccessKey,
  ): Promise<string> => {
    const result = await signRequest({
      method: "GET",
      url,
      credentials: { ...credentials, secretAccessKey },
      region,
      datetime,
      unsignedPayload: true,
    });
    return result.headers.get("authorization")!;
  };

  it("derives the key once per day and region", async () => {
    const day = new Date("2024-03-04T05:06:07Z");
    await signed("cache-region-1", day);
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    await signed("cache-region-1", new Date("2024-03-04T23:59:59Z"));
    expect(importKey).not.toHaveBeenCalled();

    await signed("cache-region-1", new Date("2024-03-05T00:00:00Z"));
    expect(importKey).toHaveBeenCalled();

    importKey.mockClear();
    await signed("cache-region-2", day);
    expect(importKey).toHaveBeenCalled();
  });

  it("shares one derivation between concurrent requests", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const day = new Date("2024-03-04T05:06:07Z");
    await signed("cache-region-3", day);
    const once = importKey.mock.calls.length;
    importKey.mockClear();

    const [first, second] = await Promise.all([
      signed("cache-region-5", day),
      signed("cache-region-5", day),
    ]);

    expect(first).toBe(second);
    expect(importKey).toHaveBeenCalledTimes(once);
  });

  it("keeps one key per access key, so two credentials never evict each other", async () => {
    const day = new Date("2024-03-04T05:06:07Z");
    const sign = (accessKeyId: string, secretAccessKey: string) =>
      signRequest({
        method: "GET",
        url,
        credentials: { accessKeyId, secretAccessKey },
        region: "cache-region-6",
        datetime: day,
        unsignedPayload: true,
      });
    await sign("AKIDONE", "secret-one");
    await sign("AKIDTWO", "secret-two");
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    await sign("AKIDONE", "secret-one");
    await sign("AKIDTWO", "secret-two");

    expect(importKey).not.toHaveBeenCalled();
  });

  it("never signs with the key of another secret", async () => {
    const day = new Date("2024-03-04T05:06:07Z");
    const original = await signed("cache-region-4", day);

    const rotated = await signed("cache-region-4", day, "a-different-secret");

    expect(rotated).not.toBe(original);
    const signature = /Signature=([\da-f]+)/.exec(rotated)![1];
    const key = deriveSigningKey("a-different-secret", "20240304", "cache-region-4", "s3");
    const canonical = [
      "GET",
      "/test.txt",
      "",
      `host:${url.host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:20240304T050607Z\n`,
      "host;x-amz-content-sha256;x-amz-date",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      "20240304T050607Z",
      "20240304/cache-region-4/s3/aws4_request",
      createHash("sha256").update(canonical, "utf8").digest("hex"),
    ].join("\n");
    expect(signature).toBe(createHmac("sha256", key).update(stringToSign, "utf8").digest("hex"));
  });

  it("knows the hash of an empty payload without computing it", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");

    const result = await signRequest({ method: "DELETE", url, credentials, region: "us-east-1" });

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
