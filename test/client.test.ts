import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Credentials, S3Client, S3Error } from "../src/index.ts";

const credentials: Credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

describe("S3Client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2023-01-02T03:04:05Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("performs PUT with inferred content type and hashed payload", async () => {
    let capturedRequest: Request | undefined;
    const fetchMock = createFetchMock(async (request) => {
      capturedRequest = request;
      return new Response(null, { status: 200 });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
    });

    await client.put({
      bucket: "my-bucket",
      key: "data.json",
      body: '{"hello":true}',
    });

    expect(capturedRequest).toBeDefined();
    const headers = capturedRequest!.headers;
    expect(headers.get("content-type")).toBe("application/json");
    const payloadHash = headers.get("x-amz-content-sha256");
    expect(payloadHash).toBe(createHash("sha256").update('{"hello":true}', "utf8").digest("hex"));
    expect(headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256/);
  });

  it("declares an explicit content-length on a PUT", async () => {
    let capturedRequest: Request | undefined;
    const fetchMock = createFetchMock(async (request) => {
      capturedRequest = request;
      return new Response(null, { status: 200 });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
    });

    const payload = new TextEncoder().encode("declared payload");
    await client.put({
      bucket: "my-bucket",
      key: "declared.bin",
      body: payload,
      contentLength: payload.byteLength,
    });

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.headers.get("content-length")).toBe(String(payload.byteLength));
  });

  it("performs anonymous GET when no credentials are provided", async () => {
    let capturedRequest: Request | undefined;
    const fetchMock = createFetchMock(async (request) => {
      capturedRequest = request;
      return new Response("hello world", { status: 200 });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      // No credentials provided
      fetch: fetchMock,
    });

    const body = await client
      .get({
        bucket: "public-bucket",
        key: "hello.txt",
      })
      .then((res) => res.text());

    expect(body).toBe("hello world");
    expect(capturedRequest).toBeDefined();
    const headers = capturedRequest!.headers;
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-amz-date")).toBe(false);
  });

  it("handles 403 Forbidden with upstream error propagation", async () => {
    const fetchMock = createFetchMock(async () => {
      // Simulate S3 Access Denied error
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>AccessDenied</Code>
    <Message>Access Denied</Message>
    <RequestId>REQUESTID123</RequestId>
    <HostId>HOSTID123</HostId>
</Error>`,
        {
          status: 403,
          headers: {
            "content-type": "application/xml",
            "x-amz-request-id": "REQUESTID123",
            "x-amz-id-2": "HOSTID123",
          },
        },
      );
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
    });

    const error = await client
      .del({ bucket: "my-bucket", key: "protected.txt" })
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(S3Error);
    expect(error).toMatchObject({ status: 403, code: "AccessDenied", requestId: "REQUESTID123" });
  });

  it("lists objects and parses XML response", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>test.txt</Key>
    <LastModified>2023-01-01T12:00:00.000Z</LastModified>
    <ETag>"abc123"</ETag>
    <Size>5</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <CommonPrefixes>
    <Prefix>photos/</Prefix>
  </CommonPrefixes>
</ListBucketResult>`;

    let capturedUrl: URL | undefined;
    const fetchMock = createFetchMock(async (request) => {
      capturedUrl = new URL(request.url);
      return new Response(xml, {
        status: 200,
        headers: { "content-type": "application/xml" },
      });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
    });

    const result = await client.list({ bucket: "my-bucket" });
    expect(capturedUrl).toBeDefined();
    expect(capturedUrl!.searchParams.get("list-type")).toBe("2");
    expect(result.isTruncated).toBe(false);
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toMatchObject({
      key: "test.txt",
      size: 5,
      etag: "abc123",
      storageClass: "STANDARD",
    });
    expect(result.commonPrefixes).toEqual(["photos/"]);
  });

  it("throws structured error on non-success response", async () => {
    const errorXml = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchKey</Code>
  <Message>The resource you requested does not exist</Message>
</Error>`;

    const fetchMock = createFetchMock(async () => {
      return new Response(errorXml, {
        status: 404,
        headers: {
          "x-amz-request-id": "123",
          "x-amz-id-2": "456",
          "content-type": "application/xml",
        },
      });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
    });

    const promise = client.get({ bucket: "my-bucket", key: "missing.txt" });
    await expect(promise).rejects.toBeInstanceOf(S3Error);
    await expect(promise).rejects.toMatchObject({
      status: 404,
      code: "NoSuchKey",
      requestId: "123",
      extendedRequestId: "456",
    });
  });

  it("filters disallowed headers from error cause", async () => {
    const errorXml = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>BadRequest</Code>
  <Message>Bad Request</Message>
</Error>`;

    const fetchMock = createFetchMock(async () => {
      return new Response(errorXml, {
        status: 400,
        headers: {
          "x-custom-header": "allowed",
          "content-length": "123",
          "content-type": "application/xml",
          "x-amz-request-id": "123",
        },
      });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
    });

    const error = await client
      .get({ bucket: "my-bucket", key: "bad.txt" })
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(S3Error);
    const { headers } = (error as S3Error).cause as { headers: Record<string, string> };
    expect(headers["x-custom-header"]).toBe("allowed");
    expect(headers["x-amz-request-id"]).toBe("123");
    expect(headers["content-length"]).toBeUndefined();
    expect(headers["content-type"]).toBeUndefined();
  });

  it("presigns requests with expected query parameters", async () => {
    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
    });

    const url = await client.getSignedUrl({
      method: "GET",
      bucket: "my-bucket",
      key: "hello.txt",
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(parsed.searchParams.get("X-Amz-Credential")).toContain(
      "AKIDEXAMPLE/20230102/us-east-1/s3/aws4_request",
    );
    expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("applies range and conditional headers", async () => {
    const requests: Request[] = [];
    const fetchMock = createFetchMock(async (request) => {
      requests.push(request);
      return new Response(null, { status: 200 });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
    });

    await client.get({
      bucket: "my-bucket",
      key: "object.txt",
      range: { start: 0, end: 99 },
      ifMatch: ['"etag-1"', '"etag-2"'],
      ifNoneMatch: "not-match",
      ifModifiedSince: new Date("2023-01-01T00:00:00Z"),
      ifUnmodifiedSince: new Date("2023-02-01T00:00:00Z"),
    });

    expect(requests).toHaveLength(1);
    const headers = requests[0]!.headers;
    expect(headers.get("range")).toBe("bytes=0-99");
    expect(headers.get("if-match")).toBe('"etag-1", "etag-2"');
    expect(headers.get("if-none-match")).toBe("not-match");
    expect(headers.get("if-modified-since")).toBe("Sun, 01 Jan 2023 00:00:00 GMT");
    expect(headers.get("if-unmodified-since")).toBe("Wed, 01 Feb 2023 00:00:00 GMT");
  });

  it("treats 304 Not Modified as success for GET requests", async () => {
    const fetchMock = createFetchMock(async () => {
      return new Response(null, {
        status: 304,
        headers: {
          "etag": '"abc123"',
          "last-modified": "Sun, 01 Jan 2023 00:00:00 GMT",
        },
      });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
    });

    const response = await client.get({
      bucket: "my-bucket",
      key: "cached.txt",
      ifNoneMatch: '"abc123"',
    });

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"abc123"');
  });

  it("treats 304 Not Modified as success for HEAD requests", async () => {
    const fetchMock = createFetchMock(async () => {
      return new Response(null, {
        status: 304,
        headers: {
          "etag": '"def456"',
          "last-modified": "Mon, 02 Jan 2023 00:00:00 GMT",
        },
      });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
    });

    const response = await client.head({
      bucket: "my-bucket",
      key: "metadata.txt",
      ifModifiedSince: new Date("2023-01-03T00:00:00Z"),
    });

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"def456"');
  });

  it("retries GET after RequestTimeTooSkewed using server time", async () => {
    const errorXml = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>RequestTimeTooSkewed</Code>
  <Message>The difference between the request time and the current time is too large.</Message>
  <Region>us-west-2</Region>
</Error>`;

    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      if (requests.length === 1) {
        return new Response(errorXml, {
          status: 403,
          headers: {
            "date": "Wed, 01 Feb 2023 00:00:00 GMT",
            "content-type": "application/xml",
          },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
      retry: { maxAttempts: 2, baseDelayMs: 0, jitter: false },
    });

    const response = await client.get({
      bucket: "my-bucket",
      key: "clock.txt",
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests[0]!.headers.get("x-amz-date")).toBe("20230102T030405Z");
    expect(requests[1]!.headers.get("x-amz-date")).toBe("20230201T000000Z");
  });

  it("adds checksum headers when configured", async () => {
    let captured: Request | undefined;
    const fetchMock = createFetchMock(async (request) => {
      captured = request;
      return new Response(null, { status: 200 });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
      checksum: { algorithm: "sha256" },
    });

    const body = "checksum-body";
    await client.put({ bucket: "my-bucket", key: "data.bin", body });

    expect(captured).toBeDefined();
    const headers = captured!.headers;
    expect(headers.get("x-amz-checksum-sha256")).toBe(
      createHash("sha256").update(body, "utf8").digest("base64"),
    );
  });

  it("throws when checksum is required but payload is streaming", async () => {
    const fetchMock = createFetchMock(async () => {
      return new Response(null, { status: 200 });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
      checksum: { algorithm: "sha256", requireOnPut: true },
    });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    const promise = client.put({
      bucket: "my-bucket",
      key: "stream.bin",
      body: stream,
    });

    await expect(promise).rejects.toThrow(/Unable to compute sha256 checksum for PUT payload/i);
  });

  it("surfaces retry metadata on structured errors", async () => {
    const errorXml = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>SlowDown</Code>
  <Message>Reduce your request rate.</Message>
  <Resource>/bucket/object</Resource>
  <Region>us-west-1</Region>
</Error>`;

    const fetchMock = createFetchMock(async () => {
      return new Response(errorXml, {
        status: 503,
        headers: {
          "retry-after": "3",
          "x-amz-request-id": "req-123",
          "x-amz-id-2": "ext-456",
          "x-amz-bucket-region": "eu-central-1",
        },
      });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
      retry: { maxAttempts: 1, baseDelayMs: 0 },
    });

    const promise = client.get({ bucket: "my-bucket", key: "object" });
    await expect(promise).rejects.toBeInstanceOf(S3Error);
    await expect(promise).rejects.toMatchObject({
      retriable: true,
      retryAfter: 3,
      resource: "/bucket/object",
      region: "us-west-1",
      bucketRegion: "eu-central-1",
    });
  });

  it("initiates multipart uploads and parses upload ids", async () => {
    let captured: Request | undefined;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult>
  <Bucket>my-bucket</Bucket>
  <Key>photos/raw.png</Key>
  <UploadId>upload-123</UploadId>
</InitiateMultipartUploadResult>`;

    const fetchMock = createFetchMock(async (request) => {
      captured = request;
      return new Response(xml, { status: 200 });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
    });

    const result = await client.initiateMultipart({
      bucket: "my-bucket",
      key: "photos/raw.png",
      contentType: "image/png",
      headers: { "x-amz-meta-origin": "camera" },
    });

    expect(result.uploadId).toBe("upload-123");
    expect(captured).toBeDefined();
    const request = captured!;
    expect(request.method).toBe("POST");
    const url = new URL(request.url);
    expect(url.searchParams.has("uploads")).toBe(true);
    expect(url.searchParams.get("uploads")).toBe("");
    expect(url.pathname.endsWith("/photos/raw.png")).toBe(true);
    expect(request.headers.get("content-type")).toBe("image/png");
    expect(request.headers.get("x-amz-meta-origin")).toBe("camera");
    expect(await request.clone().text()).toBe("");
  });

  it("uploads parts and normalizes returned ETags", async () => {
    let captured: Request | undefined;
    const fetchMock = createFetchMock(async (request) => {
      captured = request;
      return new Response(null, {
        status: 200,
        headers: { etag: '"part-etag"' },
      });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
    });

    const payload = new TextEncoder().encode("part payload");
    const result = await client.uploadPart({
      bucket: "my-bucket",
      key: "photos/raw.png",
      uploadId: "upload-123",
      partNumber: 1,
      body: payload,
      contentLength: payload.byteLength,
    });

    expect(result.etag).toBe("part-etag");
    expect(captured).toBeDefined();
    const request = captured!;
    expect(request.method).toBe("PUT");
    const url = new URL(request.url);
    expect(url.searchParams.get("uploadId")).toBe("upload-123");
    expect(url.searchParams.get("partNumber")).toBe("1");
    expect(request.headers.get("content-length")).toBe(String(payload.byteLength));
  });

  it("completes multipart uploads with sorted XML body", async () => {
    let captured: Request | undefined;
    const fetchMock = createFetchMock(async (request) => {
      captured = request;
      return new Response("<CompleteMultipartUploadResult></CompleteMultipartUploadResult>", {
        status: 200,
      });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
    });

    const response = await client.completeMultipart({
      bucket: "my-bucket",
      key: "photos/raw.png",
      uploadId: "upload-123",
      parts: [
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 1, etag: "etag-1" },
      ],
    });

    expect(response.status).toBe(200);
    expect(captured).toBeDefined();
    const request = captured!;
    expect(request.headers.get("content-type")).toBe("application/xml");
    const body = await request.clone().text();
    const firstIndex = body.indexOf("<PartNumber>1</PartNumber>");
    const secondIndex = body.indexOf("<PartNumber>2</PartNumber>");
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(-1);
    expect(firstIndex).toBeLessThan(secondIndex);
    expect(body).toContain('<ETag>"etag-1"</ETag>');
    expect(body).toContain('<ETag>"etag-2"</ETag>');
  });

  it("aborts multipart uploads", async () => {
    let seen = false;
    const fetchMock = createFetchMock(async (request) => {
      seen = true;
      expect(request.method).toBe("DELETE");
      const url = new URL(request.url);
      expect(url.searchParams.get("uploadId")).toBe("upload-123");
      return new Response(null, { status: 204 });
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock,
    });

    await expect(
      client.abortMultipart({
        bucket: "my-bucket",
        key: "photos/raw.png",
        uploadId: "upload-123",
      }),
    ).resolves.toBeUndefined();
    expect(seen).toBe(true);
  });

  it("rejects invalid part numbers before making requests", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should not be invoked");
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const promise = client.uploadPart({
      bucket: "my-bucket",
      key: "photos/raw.png",
      uploadId: "upload-123",
      partNumber: 0,
      body: "",
    });

    await expect(promise).rejects.toBeInstanceOf(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects completion with duplicate parts", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should not be invoked");
    });

    const client = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      credentials,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const promise = client.completeMultipart({
      bucket: "my-bucket",
      key: "photos/raw.png",
      uploadId: "upload-123",
      parts: [
        { partNumber: 1, etag: "etag-1" },
        { partNumber: 1, etag: "etag-dup" },
      ],
    });

    await expect(promise).rejects.toThrow(/duplicate part numbers/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function createFetchMock(
  responder: (request: Request) => Promise<Response> | Response,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return await responder(request);
  }) as typeof fetch;
}
