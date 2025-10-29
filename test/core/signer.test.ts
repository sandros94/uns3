import { createHash, createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { presignUrl, signRequest } from "../../src/core/signer";
import type { Credentials } from "../../src/types";

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
    const url = new URL(
      "https://my-bucket.s3.us-east-1.amazonaws.com/test.txt",
    );

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

    const canonicalHash = createHash("sha256")
      .update(canonicalRequest, "utf8")
      .digest("hex");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      result.amzDate,
      `20230102/us-east-1/s3/aws4_request`,
      canonicalHash,
    ].join("\n");

    const signingKey = deriveSigningKey(
      credentials.secretAccessKey,
      "20230102",
      "us-east-1",
      "s3",
    );
    const expectedSignature = createHmac("sha256", signingKey)
      .update(stringToSign, "utf8")
      .digest("hex");

    expect(auth).toBe(
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/20230102/us-east-1/s3/aws4_request, SignedHeaders=${result.signedHeaders}, Signature=${expectedSignature}`,
    );
  });

  it("presigns URLs with stable signature", async () => {
    const url = new URL(
      "https://my-bucket.s3.us-east-1.amazonaws.com/test.txt",
    );

    const { url: presigned } = await presignUrl({
      method: "GET",
      url,
      credentials,
      region: "us-east-1",
      unsignedPayload: true,
      expiresInSeconds: 900,
    });

    const parsed = presigned;
    const params = parsed.searchParams;
    expect(params.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    const credential = params.get("X-Amz-Credential");
    expect(credential).toBe(
      `${credentials.accessKeyId}/20230102/us-east-1/s3/aws4_request`,
    );
    const signature = params.get("X-Amz-Signature");
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
  });
});

function deriveSigningKey(
  secret: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const kDate = createHmac("sha256", `AWS4${secret}`)
    .update(date, "utf8")
    .digest();
  const kRegion = createHmac("sha256", kDate).update(region, "utf8").digest();
  const kService = createHmac("sha256", kRegion)
    .update(service, "utf8")
    .digest();
  return createHmac("sha256", kService).update("aws4_request", "utf8").digest();
}
