import { createHash } from "node:crypto";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { S3Client, S3Error } from "../src";
import type { Credentials } from "../src/types";

const credentials: Credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

const integrationEnv = {
  region: process.env.VITE_S3_REGION,
  bucket: process.env.VITE_S3_BUCKET,
  endpoint: process.env.VITE_S3_ENDPOINT,
  accessKeyId: process.env.VITE_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.VITE_S3_SECRET_ACCESS_KEY,
  sessionToken: process.env.VITE_S3_SESSION_TOKEN,
} as const;

const integrationSuite =
  integrationEnv.region &&
  integrationEnv.bucket &&
  integrationEnv.endpoint &&
  integrationEnv.accessKeyId &&
  integrationEnv.secretAccessKey
    ? describe
    : describe.skip;

// #region Mocked Client Tests

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
    expect(payloadHash).toBe(
      createHash("sha256").update('{"hello":true}', "utf8").digest("hex"),
    );
    expect(headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256/);
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
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(
      /^[a-f0-9]{64}$/,
    );
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
    expect(headers.get("if-modified-since")).toBe(
      "Sun, 01 Jan 2023 00:00:00 GMT",
    );
    expect(headers.get("if-unmodified-since")).toBe(
      "Wed, 01 Feb 2023 00:00:00 GMT",
    );
  });

  it("retries GET after RequestTimeTooSkewed using server time", async () => {
    const errorXml = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>RequestTimeTooSkewed</Code>
  <Message>The difference between the request time and the current time is too large.</Message>
  <Region>us-west-2</Region>
</Error>`;

    const requests: Request[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        if (requests.length === 1) {
          return new Response(errorXml, {
            status: 403,
            headers: {
              date: "Wed, 01 Feb 2023 00:00:00 GMT",
              "content-type": "application/xml",
            },
          });
        }
        return new Response("ok", { status: 200 });
      },
    );

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

    await expect(promise).rejects.toThrow(
      /Unable to compute sha256 checksum for PUT payload/i,
    );
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
});

// #region Real Bucket Tests

integrationSuite("S3Client integration (real bucket)", () => {
  const bucket = integrationEnv.bucket!;
  const prefix = `uns3-it/${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const trackedKeys = new Set<string>();
  let client: S3Client;

  beforeAll(() => {
    vi.useRealTimers();
    vi.setSystemTime(new Date());
    client = new S3Client({
      region: integrationEnv.region!,
      endpoint: integrationEnv.endpoint!,
      credentials: {
        accessKeyId: integrationEnv.accessKeyId!,
        secretAccessKey: integrationEnv.secretAccessKey!,
        ...(integrationEnv.sessionToken
          ? { sessionToken: integrationEnv.sessionToken }
          : {}),
      },
    });
  });

  beforeEach(() => {
    vi.useRealTimers();
    vi.setSystemTime(new Date());
  });

  afterEach(async () => {
    if (trackedKeys.size === 0) return;
    await deleteKeys(trackedKeys);
    trackedKeys.clear();
  });

  afterAll(async () => {
    await purgePrefix();
  });

  it("uploads, reads, and deletes an object", async () => {
    const key = `${prefix}/roundtrip-${Date.now()}.json`;
    trackedKeys.add(key);
    const payload = JSON.stringify({ now: Date.now() });

    const putResponse = await client.put({
      bucket,
      key,
      body: payload,
      contentType: "application/json",
    });
    expect([200, 201]).toContain(putResponse.status);
    putResponse.body?.cancel?.();

    const getResponse = await client.get({ bucket, key });
    expect(getResponse.status).toBe(200);
    expect(await getResponse.text()).toBe(payload);

    const headResponse = await client.head({ bucket, key });
    expect(headResponse.status).toBe(200);
    const contentType = headResponse.headers.get("content-type");
    expect(contentType).toBeTruthy();
    expect(contentType?.toLowerCase()).toContain("application/json");
  });

  it("lists objects with the created prefix", async () => {
    const key = `${prefix}/list-${Date.now()}.txt`;
    trackedKeys.add(key);
    const putResponse = await client.put({ bucket, key, body: "list-check" });
    expect([200, 201]).toContain(putResponse.status);
    putResponse.body?.cancel?.();

    const result = await client.list({ bucket, prefix });
    const seen = result.contents.some((item) => item.key === key);

    expect(seen).toBe(true);
  });

  it("creates a working presigned GET URL", async () => {
    const key = `${prefix}/presign-${Date.now()}.txt`;
    trackedKeys.add(key);
    const body = "presign payload";
    const putResponse = await client.put({ bucket, key, body });
    expect([200, 201]).toContain(putResponse.status);
    putResponse.body?.cancel?.();

    const url = await client.getSignedUrl({ method: "GET", bucket, key });
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
  });

  async function deleteKeys(keys: Iterable<string>): Promise<void> {
    for (const key of keys) {
      try {
        await client.del({ bucket, key });
      } catch (error) {
        console.warn(`[uns3] failed to delete ${key}:`, error);
      }
    }
  }

  async function purgePrefix(): Promise<void> {
    let continuation: string | undefined;
    do {
      const result = await client.list({
        bucket,
        prefix,
        continuationToken: continuation,
      });
      if (result.contents.length > 0) {
        await deleteKeys(result.contents.map((item) => item.key));
      }
      continuation = result.nextContinuationToken;
      if (!result.isTruncated) {
        break;
      }
    } while (continuation);
  }
});

function createFetchMock(
  responder: (request: Request) => Promise<Response> | Response,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return await responder(request);
  }) as typeof fetch;
}
