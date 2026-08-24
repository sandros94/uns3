/*
 * `expectedStatus` is declared on `BaseRequest`, documented as "Expected HTTP
 * status code(s); a mismatch throws an `S3Error`", and inherited by every
 * parameter type in the public API. Every method used to ignore it and pass a
 * hard-coded list to the transport instead, which made the documented option a
 * no-op and — worse — made `range` unusable: the client serializes a `Range`
 * header from `params.range`, a store answers the correct `206 Partial Content`,
 * and the hard-coded list did not contain 206, so the body was cancelled and an
 * `S3Error` thrown. Every ranged read was dead.
 *
 * This suite pins the contract: a caller's `expectedStatus` REPLACES the default
 * (it does not merge with it), and the defaults themselves are right — 206 among
 * them for the two methods that can produce one.
 */

import { describe, expect, it } from "vitest";

import { type Credentials, S3Client, S3Error } from "../src/index.ts";

const credentials: Credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

const BUCKET = "my-bucket";
const KEY = "object.txt";

/** A client whose every request is answered by `responder`. */
function clientAnswering(responder: (request: Request) => Response | Promise<Response>): {
  client: S3Client;
  requests: Request[];
} {
  const requests: Request[] = [];
  const client = new S3Client({
    region: "us-east-1",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    credentials,
    /* No retries: a test that pins a thrown status should not wait out a backoff. */
    retry: { maxAttempts: 1, baseDelayMs: 0 },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return await responder(request);
    }) as typeof fetch,
  });
  return { client, requests };
}

/** A client that answers every request with `status` and `body`, unconditionally. */
function clientReturning(
  status: number,
  body?: BodyInit | null,
  headers?: HeadersInit,
): { client: S3Client; requests: Request[] } {
  return clientAnswering(() => new Response(body ?? null, { status, headers }));
}

describe("expectedStatus defaults", () => {
  it("accepts a 206 on a ranged GET, and hands back the slice", async () => {
    /* The regression this whole suite exists for. The client serialized the
       Range header itself, so 206 is the *correct* answer to its own request. */
    const slice = "56789";
    const { client, requests } = clientReturning(206, slice, {
      "content-range": "bytes 5-9/20",
    });

    const response = await client.get({ bucket: BUCKET, key: KEY, range: { start: 5, end: 9 } });

    expect(requests[0]!.headers.get("range")).toBe("bytes=5-9");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 5-9/20");
    /* The old code cancelled the body on its way to throwing; the body must
       still be readable, which is the whole point of a ranged read. */
    await expect(response.text()).resolves.toBe(slice);
  });

  it("accepts a 206 on an open-ended ranged GET", async () => {
    const { client, requests } = clientReturning(206, "tail", {
      "content-range": "bytes 16-19/20",
    });

    const response = await client.get({ bucket: BUCKET, key: KEY, range: { start: 16 } });

    expect(requests[0]!.headers.get("range")).toBe("bytes=16-");
    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe("tail");
  });

  it("accepts a 206 on a ranged HEAD", async () => {
    /* A ranged HEAD answers 206 with the same headers and no body. */
    const { client } = clientReturning(206, null, { "content-range": "bytes 0-3/20" });

    const response = await client.head({ bucket: BUCKET, key: KEY, range: { start: 0, end: 3 } });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-3/20");
  });

  it("still accepts the statuses the defaults always covered", async () => {
    const cases: Array<[string, number, () => Promise<Response>]> = [];

    const get200 = clientReturning(200, "body");
    cases.push(["get 200", 200, async () => await get200.client.get({ bucket: BUCKET, key: KEY })]);

    const get304 = clientReturning(304);
    cases.push([
      "get 304",
      304,
      async () => await get304.client.get({ bucket: BUCKET, key: KEY, ifNoneMatch: '"e"' }),
    ]);

    const head304 = clientReturning(304);
    cases.push([
      "head 304",
      304,
      async () => await head304.client.head({ bucket: BUCKET, key: KEY, ifNoneMatch: '"e"' }),
    ]);

    const put412 = clientReturning(412);
    cases.push([
      "put 412",
      412,
      async () => await put412.client.put({ bucket: BUCKET, key: KEY, body: "x", ifMatch: '"e"' }),
    ]);

    const del204 = clientReturning(204);
    cases.push(["del 204", 204, async () => await del204.client.del({ bucket: BUCKET, key: KEY })]);

    for (const [, status, run] of cases) {
      const response = await run();
      expect(response.status).toBe(status);
    }
  });

  it("still throws on a status no default covers", async () => {
    const { client } = clientReturning(404, "<Error><Code>NoSuchKey</Code></Error>");

    await expect(client.get({ bucket: BUCKET, key: KEY })).rejects.toBeInstanceOf(S3Error);
  });
});

describe("expectedStatus overrides", () => {
  it("replaces the default rather than adding to it", async () => {
    /* A caller who names an exact status means it: 304 is no longer a success
       once `expectedStatus: 200` has been asked for. */
    const { client } = clientReturning(304);

    await expect(
      client.get({ bucket: BUCKET, key: KEY, ifNoneMatch: '"e"', expectedStatus: 200 }),
    ).rejects.toBeInstanceOf(S3Error);
  });

  it("is honored by get", async () => {
    const { client } = clientReturning(404, "<Error><Code>NoSuchKey</Code></Error>");

    const response = await client.get({
      bucket: BUCKET,
      key: KEY,
      expectedStatus: [200, 404],
    });

    expect(response.status).toBe(404);
  });

  it("is honored by head", async () => {
    const { client } = clientReturning(404);

    const response = await client.head({ bucket: BUCKET, key: KEY, expectedStatus: [200, 404] });

    expect(response.status).toBe(404);
  });

  it("is honored by put", async () => {
    /* 201 is what a handful of S3-compatible stores answer to a PUT. */
    const { client } = clientReturning(201);

    const response = await client.put({
      bucket: BUCKET,
      key: KEY,
      body: "hello",
      expectedStatus: [200, 201],
    });

    expect(response.status).toBe(201);
  });

  it("is honored by del", async () => {
    const { client } = clientReturning(202);

    const response = await client.del({ bucket: BUCKET, key: KEY, expectedStatus: [202, 204] });

    expect(response.status).toBe(202);
  });

  it("is honored by list", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Contents>
    <Key>a.txt</Key>
    <Size>3</Size>
    <LastModified>2023-01-01T00:00:00.000Z</LastModified>
  </Contents>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`;
    const { client } = clientReturning(206, xml);

    const result = await client.list({ bucket: BUCKET, expectedStatus: [200, 206] });

    expect(result.contents.map((item) => item.key)).toEqual(["a.txt"]);
  });

  it("is honored by initiateMultipart", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult><UploadId>upload-123</UploadId></InitiateMultipartUploadResult>`;
    const { client } = clientReturning(201, xml);

    const result = await client.initiateMultipart({
      bucket: BUCKET,
      key: KEY,
      expectedStatus: [200, 201],
    });

    expect(result.uploadId).toBe("upload-123");
  });

  it("is honored by uploadPart", async () => {
    const { client } = clientReturning(201, null, { etag: '"part-etag"' });

    const result = await client.uploadPart({
      bucket: BUCKET,
      key: KEY,
      uploadId: "upload-123",
      partNumber: 1,
      body: "chunk",
      expectedStatus: [200, 201],
    });

    expect(result.etag).toBe("part-etag");
  });

  it("is honored by completeMultipart", async () => {
    const { client } = clientReturning(201, "<CompleteMultipartUploadResult/>");

    const response = await client.completeMultipart({
      bucket: BUCKET,
      key: KEY,
      uploadId: "upload-123",
      parts: [{ partNumber: 1, etag: "etag-1" }],
      expectedStatus: [200, 201],
    });

    expect(response.status).toBe(201);
  });

  it("is honored by abortMultipart", async () => {
    /* Aborting an upload that is already gone answers 404, and a caller who
       wants that to be idempotent has no other way to say so. */
    const { client } = clientReturning(404, "<Error><Code>NoSuchUpload</Code></Error>");

    await expect(
      client.abortMultipart({
        bucket: BUCKET,
        key: KEY,
        uploadId: "upload-123",
        expectedStatus: [204, 404],
      }),
    ).resolves.toBeUndefined();
  });

  it("throws when the response misses a caller-named status", async () => {
    const { client } = clientReturning(200, "body");

    await expect(
      client.get({ bucket: BUCKET, key: KEY, expectedStatus: [206] }),
    ).rejects.toBeInstanceOf(S3Error);
  });
});
