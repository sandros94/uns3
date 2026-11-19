/*
 * What a response has to look like before the client believes it.
 *
 * A status is not the whole answer. S3 can report a failure inside a `200`
 * (CompleteMultipartUpload says so outright), a proxy can answer a listing
 * with an HTML page, and a redirect names a region the request was never
 * signed for.
 */

import { describe, expect, it } from "vitest";

import { S3Error } from "../src/index.ts";
import { BUCKET, clientAnswering, xmlError } from "./_client.ts";

const COMPLETED = `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult>
  <Location>https://my-bucket.s3.amazonaws.com/big.bin</Location>
  <Bucket>my-bucket</Bucket>
  <Key>big.bin</Key>
  <ETag>&quot;3858f62230ac3c915f300c664312c11f-2&quot;</ETag>
</CompleteMultipartUploadResult>`;

const complete = {
  bucket: BUCKET,
  key: "big.bin",
  uploadId: "u",
  parts: [{ partNumber: 1, etag: '"a"' }],
};

describe("errors inside a 200", () => {
  it("retries a multipart completion that failed inside a 200", async () => {
    let attempts = 0;
    const { client, requests } = clientAnswering(
      () =>
        ++attempts === 1
          ? new Response("<Error><Code>InternalError</Code></Error>", { status: 200 })
          : new Response(COMPLETED, { status: 200 }),
      { retry: { maxAttempts: 2, baseDelayMs: 0 } },
    );

    const result = await client.completeMultipart(complete);

    expect(requests).toHaveLength(2);
    expect(result).toEqual({
      etag: '"3858f62230ac3c915f300c664312c11f-2"',
      location: "https://my-bucket.s3.amazonaws.com/big.bin",
    });
  });

  it("reports the error a 200 carried", async () => {
    const { client } = clientAnswering(
      () => new Response("<Error><Code>InternalError</Code></Error>", { status: 200 }),
    );

    const error = await client.completeMultipart(complete).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(S3Error);
    expect(error).toMatchObject({ status: 200, code: "InternalError", retriable: true });
  });

  it("refuses a 200 with no body where a document was due", async () => {
    const { client } = clientAnswering(() => new Response(null, { status: 200 }));

    await expect(client.completeMultipart(complete)).rejects.toBeInstanceOf(S3Error);
  });

  it("refuses a listing that is not a listing", async () => {
    const { client } = clientAnswering(
      () => new Response("<html><body>Welcome to our proxy</body></html>", { status: 200 }),
    );

    await expect(client.list({ bucket: BUCKET })).rejects.toBeInstanceOf(S3Error);
  });

  it("refuses an initiation that names no upload", async () => {
    const { client } = clientAnswering(
      () =>
        new Response("<InitiateMultipartUploadResult></InitiateMultipartUploadResult>", {
          status: 200,
        }),
    );

    await expect(client.initiateMultipart({ bucket: BUCKET, key: "a.bin" })).rejects.toBeInstanceOf(
      S3Error,
    );
  });

  it("raises a failed precondition on completion rather than resolving it", async () => {
    const { client } = clientAnswering(() => xmlError(412, "PreconditionFailed"));

    await expect(client.completeMultipart({ ...complete, ifNoneMatch: "*" })).rejects.toMatchObject(
      { status: 412, code: "PreconditionFailed" },
    );
  });
});

/*
 * A redirect is never followed. Following it sends the request somewhere it
 * was not signed for, without its `Authorization` header, and the caller gets
 * the target's misleading 403 instead of the region the store named.
 */
describe("redirects", () => {
  it("does not follow a redirect", async () => {
    const { client, requests } = clientAnswering(() => new Response("ok"));

    await client.get({ bucket: BUCKET, key: "a.txt" });

    expect(requests[0]!.redirect).toBe("manual");
  });

  it("reports the region a redirect names", async () => {
    const { client } = clientAnswering(
      () =>
        new Response(
          "<Error><Code>PermanentRedirect</Code><Message>Use the right endpoint.</Message><Endpoint>my-bucket.s3.eu-west-1.amazonaws.com</Endpoint></Error>",
          { status: 301, headers: { "x-amz-bucket-region": "eu-west-1" } },
        ),
    );

    await expect(client.get({ bucket: BUCKET, key: "a.txt" })).rejects.toMatchObject({
      status: 301,
      code: "PermanentRedirect",
      bucketRegion: "eu-west-1",
      retriable: false,
    });
  });
});
