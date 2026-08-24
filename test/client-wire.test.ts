/*
 * What the client actually puts on the socket, and whether the signature it
 * attached covers those exact bytes.
 *
 * Everything here is answered by a `fetch` mock that keeps the `Request` it was
 * handed, so the assertions are about the request as constructed — its URL, its
 * headers, its body — rather than about what a store made of it. Where the
 * question is "would a strict server accept this?", the suite answers it the way
 * a strict server does: `signatureMatches` recomputes SigV4 from the wire bytes
 * alone and compares the result against the `Authorization` header the client
 * sent. AWS recomputes the canonical request byte for byte; so does this.
 */

import { createHash, createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Credentials, S3Client } from "../src/index.ts";

const credentials: Credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

const BUCKET = "my-bucket";

const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`;

describe("request bytes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2023-01-02T03:04:05Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /*
   * SIGNED QUERY VS SENT QUERY.
   *
   * The canonical query SigV4 signs is RFC 3986 — a space is `%20`. The URL that
   * used to be sent came out of `URLSearchParams.toString()`, which serialises
   * `application/x-www-form-urlencoded` — a space is `+`. Every list with a
   * space in its prefix was therefore signed for a query the server would never
   * see, and a store that recomputes the canonical request answers
   * `SignatureDoesNotMatch`. The lenient stores in the integration suite happen
   * to accept it; AWS does not, and neither does the check below.
   */
  describe("query encoding", () => {
    it("sends the query bytes the signature covers", async () => {
      const { client, requests } = clientAnswering(() => new Response(LIST_XML, { status: 200 }));

      await client.list({ bucket: BUCKET, prefix: "my folder/", delimiter: "/" });

      const url = new URL(requests[0]!.url);
      expect(url.search).toBe("?list-type=2&prefix=my%20folder%2F&delimiter=%2F");
      expect(url.search).not.toContain("+");
      expect(signatureMatches(requests[0]!)).toBe(true);
    });

    /* The control for the check above: it has to be capable of saying "yes". */
    it("verifies the signature of a request with nothing exotic in it", async () => {
      const { client, requests } = clientAnswering(() => new Response("hi", { status: 200 }));

      await client.get({ bucket: BUCKET, key: "plain.txt" });

      expect(signatureMatches(requests[0]!)).toBe(true);
    });

    it("keeps a caller's own query parameters signable", async () => {
      const { client, requests } = clientAnswering(() => new Response("hi", { status: 200 }));

      await client.get({
        bucket: BUCKET,
        key: "plain.txt",
        query: { "response-content-disposition": 'attachment; filename="my report.pdf"' },
      });

      const url = new URL(requests[0]!.url);
      expect(url.search).toContain("my%20report.pdf");
      expect(url.search).not.toContain("+");
      expect(signatureMatches(requests[0]!)).toBe(true);
    });

    it("presigns a spaced query value as %20 rather than +", async () => {
      const client = new S3Client({
        region: "us-east-1",
        endpoint: "https://s3.us-east-1.amazonaws.com",
        credentials,
      });

      const url = await client.getSignedUrl({
        method: "GET",
        bucket: BUCKET,
        key: "my file.txt",
        query: { "response-content-disposition": 'attachment; filename="my report.pdf"' },
        expiresInSeconds: 300,
      });

      expect(url).toContain("/my%20file.txt");
      expect(url.slice(url.indexOf("?"))).not.toContain("+");
      expect(url).toContain("filename%3D%22my%20report.pdf%22");
      /* Re-encoding must not re-interpret: the value still reads back as itself. */
      expect(new URL(url).searchParams.get("response-content-disposition")).toBe(
        'attachment; filename="my report.pdf"',
      );
    });
  });

  /*
   * A `ReadableStream` body used to throw before it ever reached `fetch`:
   * `new Request(url, { body: stream })` is a `TypeError` on undici, Deno, Bun
   * and workerd unless `duplex: "half"` is passed alongside it. The option is
   * only legal when there is a body, so it is set only when the body is a
   * stream, and only there.
   */
  describe("streaming bodies", () => {
    it("dispatches a streaming PUT body", async () => {
      const { client, requests } = clientAnswering(() => new Response(null, { status: 200 }));

      const response = await client.put({
        bucket: BUCKET,
        key: "streamed.bin",
        body: streamOf("streamed body"),
        contentType: "application/octet-stream",
      });

      expect(response.status).toBe(200);
      expect(requests).toHaveLength(1);
      await expect(requests[0]!.text()).resolves.toBe("streamed body");
      /* A stream cannot be hashed without consuming it, so it is signed unsigned. */
      expect(requests[0]!.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
    });

    /*
     * A stream with no length goes out chunked, which AWS S3 and RustFS refuse
     * with `411 MissingContentLength`; `contentLength` is what makes a streamed
     * PUT work against those stores. It has to be set before the request is
     * signed, exactly as `uploadPart` sets it — a `content-length` the signature
     * does not cover is one a strict store rejects.
     */
    it("signs the content-length a streaming PUT declares", async () => {
      const { client, requests } = clientAnswering(() => new Response(null, { status: 200 }));
      const body = "streamed body";
      const length = new TextEncoder().encode(body).byteLength;

      await client.put({
        bucket: BUCKET,
        key: "streamed.bin",
        body: streamOf(body),
        contentType: "application/octet-stream",
        contentLength: length,
      });

      expect(requests[0]!.headers.get("content-length")).toBe(String(length));
      expect(requests[0]!.headers.get("authorization")).toContain("content-length");
      expect(signatureMatches(requests[0]!)).toBe(true);
    });

    it("dispatches a streaming uploadPart body", async () => {
      const { client, requests } = clientAnswering(
        () => new Response(null, { status: 200, headers: { etag: '"part-etag"' } }),
      );

      const result = await client.uploadPart({
        bucket: BUCKET,
        key: "streamed.bin",
        uploadId: "upload-123",
        partNumber: 1,
        body: streamOf("part payload"),
      });

      expect(result.etag).toBe("part-etag");
      expect(requests).toHaveLength(1);
      await expect(requests[0]!.text()).resolves.toBe("part payload");
    });
  });

  /*
   * `applyChecksum` lived in `execute`, which `uploadPart` does not go through —
   * so a client configured with `checksum.requireOnPut` uploaded every part of
   * every multipart upload with no checksum at all and said nothing. The part
   * body is a payload like any other, and the same rule now covers it.
   */
  describe("checksums", () => {
    it("checksums an uploadPart body", async () => {
      const { client, requests } = clientAnswering(
        () => new Response(null, { status: 200, headers: { etag: '"part-etag"' } }),
        { checksum: { algorithm: "sha256", requireOnPut: true } },
      );

      await client.uploadPart({
        bucket: BUCKET,
        key: "photos/raw.png",
        uploadId: "upload-123",
        partNumber: 1,
        body: "part payload",
      });

      expect(requests[0]!.headers.get("x-amz-checksum-sha256")).toBe(
        createHash("sha256").update("part payload", "utf8").digest("base64"),
      );
      /* Set before signing, so the header the store validates is one it can trust. */
      expect(signatureMatches(requests[0]!)).toBe(true);
    });

    it("refuses a streaming part when a checksum is required", async () => {
      const { client, requests } = clientAnswering(
        () => new Response(null, { status: 200, headers: { etag: '"part-etag"' } }),
        { checksum: { algorithm: "sha256", requireOnPut: true } },
      );

      const promise = client.uploadPart({
        bucket: BUCKET,
        key: "photos/raw.png",
        uploadId: "upload-123",
        partNumber: 1,
        body: streamOf("part payload"),
      });

      await expect(promise).rejects.toThrow(/Unable to compute sha256 checksum for PUT payload/i);
      expect(requests).toHaveLength(0);
    });

    it("leaves a streaming part alone when a checksum is merely configured", async () => {
      const { client, requests } = clientAnswering(
        () => new Response(null, { status: 200, headers: { etag: '"part-etag"' } }),
        { checksum: { algorithm: "sha256" } },
      );

      await client.uploadPart({
        bucket: BUCKET,
        key: "photos/raw.png",
        uploadId: "upload-123",
        partNumber: 1,
        body: streamOf("part payload"),
      });

      expect(requests[0]!.headers.has("x-amz-checksum-sha256")).toBe(false);
    });
  });

  /*
   * A key is bytes; a URL path is not. See `test/core/endpoint.test.ts` for the
   * whole story — here the only question is whether the client refuses before it
   * writes somewhere the caller never named.
   */
  describe("keys with dot segments", () => {
    it("refuses to write a key a URL would rewrite", async () => {
      const { client, requests } = clientAnswering(() => new Response(null, { status: 200 }));

      await expect(
        client.put({ bucket: BUCKET, key: "users/a/../b/x", body: "escaped" }),
      ).rejects.toThrow(/dot segment/i);
      expect(requests).toHaveLength(0);
    });

    it("refuses to read one too", async () => {
      const { client, requests } = clientAnswering(() => new Response(null, { status: 200 }));

      await expect(client.get({ bucket: BUCKET, key: "dir/../evil.txt" })).rejects.toThrow(
        /dot segment/i,
      );
      expect(requests).toHaveLength(0);
    });
  });

  /*
   * CLOCK SKEW.
   *
   * `Date` has one-second resolution and a response carries the moment it was
   * generated, not the moment it arrived — so the measured difference is never
   * exactly zero, and the client used to adopt every one of those sub-second
   * measurements as a correction to its own clock. Worse, ANY intermediary that
   * answers with a `Date` (a proxy, a captive portal, an error page) could then
   * shift the signing clock of every later request.
   *
   * The rule is AWS's own: a difference only matters once it is large enough to
   * threaten the fifteen-minute signature window, so nothing under five minutes
   * from the clock already in use is adopted.
   */
  describe("clock skew", () => {
    it("ignores a sub-threshold difference in the endpoint's clock", async () => {
      const { client, requests } = clientAnswering(
        () =>
          new Response("ok", {
            status: 200,
            /* One second ahead: the resolution of the header itself. */
            headers: { date: "Mon, 02 Jan 2023 03:04:06 GMT" },
          }),
      );

      await client.get({ bucket: BUCKET, key: "first.txt" });
      await client.get({ bucket: BUCKET, key: "second.txt" });

      expect(requests[0]!.headers.get("x-amz-date")).toBe("20230102T030405Z");
      expect(requests[1]!.headers.get("x-amz-date")).toBe("20230102T030405Z");
    });

    it("adopts a difference big enough to matter", async () => {
      const { client, requests } = clientAnswering(
        () =>
          new Response("ok", {
            status: 200,
            /* Twenty minutes ahead: past the window a signature is valid in. */
            headers: { date: "Mon, 02 Jan 2023 03:24:05 GMT" },
          }),
      );

      await client.get({ bucket: BUCKET, key: "first.txt" });
      await client.get({ bucket: BUCKET, key: "second.txt" });

      expect(requests[0]!.headers.get("x-amz-date")).toBe("20230102T030405Z");
      expect(requests[1]!.headers.get("x-amz-date")).toBe("20230102T032405Z");
    });

    it("comes back when the local clock is the one that was wrong", async () => {
      /* Configured skew, then an endpoint that agrees with the local clock: the
         correction has to be droppable, not just applicable. */
      const { client, requests } = clientAnswering(
        () =>
          new Response("ok", {
            status: 200,
            headers: { date: "Mon, 02 Jan 2023 03:04:05 GMT" },
          }),
        { clockSkewMs: 20 * 60 * 1000 },
      );

      await client.get({ bucket: BUCKET, key: "first.txt" });
      await client.get({ bucket: BUCKET, key: "second.txt" });

      expect(requests[0]!.headers.get("x-amz-date")).toBe("20230102T032405Z");
      expect(requests[1]!.headers.get("x-amz-date")).toBe("20230102T030405Z");
    });
  });

  /*
   * `retry.retriable` is documented as the decision itself — "custom predicate
   * to decide whether a failed request should be retried" — so it stays
   * authoritative, and a caller who says a PUT is safe to repeat gets a repeated
   * PUT. What a predicate cannot do is conjure a body back: a stream is consumed
   * by the attempt that sent it, and there is nothing left to send a second
   * time. That is physics, not policy, and it is the one thing the predicate
   * does not get a vote on.
   */
  describe("retry policy", () => {
    it("lets a custom predicate force a retry of a PUT", async () => {
      let attempts = 0;
      const { client, requests } = clientAnswering(
        () => {
          attempts += 1;
          return attempts === 1
            ? new Response("<Error><Code>InternalError</Code></Error>", { status: 500 })
            : new Response(null, { status: 200 });
        },
        { retry: { maxAttempts: 3, baseDelayMs: 0, jitter: false, retriable: () => true } },
      );

      const response = await client.put({ bucket: BUCKET, key: "retried.txt", body: "payload" });

      expect(response.status).toBe(200);
      expect(requests).toHaveLength(2);
      await expect(requests[1]!.text()).resolves.toBe("payload");
    });

    it("never retries a streamed body, whatever the predicate says", async () => {
      const { client, requests } = clientAnswering(
        () => new Response("<Error><Code>InternalError</Code></Error>", { status: 500 }),
        { retry: { maxAttempts: 3, baseDelayMs: 0, jitter: false, retriable: () => true } },
      );

      const promise = client.put({
        bucket: BUCKET,
        key: "streamed.bin",
        body: streamOf("one shot"),
      });

      /* The original 500 surfaces, rather than a `TypeError` about a used body. */
      await expect(promise).rejects.toMatchObject({ status: 500, code: "InternalError" });
      expect(requests).toHaveLength(1);
    });
  });
});

/** A one-chunk stream, which is the smallest body that is not also a buffer. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** A client whose every request is answered by `responder`, and kept. */
function clientAnswering(
  responder: (request: Request) => Response | Promise<Response>,
  config: Partial<ConstructorParameters<typeof S3Client>[0]> = {},
): { client: S3Client; requests: Request[] } {
  const requests: Request[] = [];
  const client = new S3Client({
    region: "us-east-1",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    credentials,
    retry: { maxAttempts: 1, baseDelayMs: 0 },
    ...config,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return await responder(request);
    }) as typeof fetch,
  });
  return { client, requests };
}

/**
 * Recomputes a request's signature from the bytes on the wire and compares it
 * with the `Authorization` header that was sent.
 *
 * This is deliberately written against the request rather than against the
 * client's own signer: it reads the raw query string, decodes it by RFC 3986
 * rules (where `+` is a plus, not a space, which is the whole point), sorts,
 * re-encodes, and derives the signature with an independent HMAC. If the client
 * signs one query and sends another, the two signatures differ and this returns
 * false — exactly as a store would.
 */
function signatureMatches(request: Request): boolean {
  const auth = request.headers.get("authorization");
  if (!auth) return false;

  const credential = /Credential=([^,]+)/.exec(auth)?.[1];
  const signedHeaders = /SignedHeaders=([^,]+)/.exec(auth)?.[1];
  const signature = /Signature=([\da-f]+)/.exec(auth)?.[1];
  if (!credential || !signedHeaders || !signature) return false;

  const scope = credential.slice(credential.indexOf("/") + 1);
  const [shortDate, region, service] = scope.split("/");
  const url = new URL(request.url);

  const canonicalUri = url.pathname
    .split("/")
    .map((segment) => (segment ? rfc3986(decodeURIComponent(segment)) : segment))
    .join("/");

  const canonicalHeaders = signedHeaders
    .split(";")
    .map((name) => `${name}:${headerOf(request, name)}`)
    .join("\n");

  const canonicalRequest = [
    request.method,
    canonicalUri,
    canonicalQuery(url.search),
    `${canonicalHeaders}\n`,
    signedHeaders,
    request.headers.get("x-amz-content-sha256") ?? "",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    request.headers.get("x-amz-date") ?? "",
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");

  const kDate = createHmac("sha256", `AWS4${credentials.secretAccessKey}`)
    .update(shortDate!, "utf8")
    .digest();
  const kRegion = createHmac("sha256", kDate).update(region!, "utf8").digest();
  const kService = createHmac("sha256", kRegion).update(service!, "utf8").digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request", "utf8").digest();

  return createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex") === signature;
}

/** `host` is signed but not always readable back off a `Request`; the URL has it. */
function headerOf(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (value !== null) return value.trim().replace(/\s+/g, " ");
  return name === "host" ? new URL(request.url).host : "";
}

function canonicalQuery(search: string): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (!raw) return "";
  return raw
    .split("&")
    .map((pair) => {
      const separator = pair.indexOf("=");
      const key = separator === -1 ? pair : pair.slice(0, separator);
      const value = separator === -1 ? "" : pair.slice(separator + 1);
      return { key: decodeURIComponent(key), value: decodeURIComponent(value) };
    })
    .sort((a, b) => (a.key === b.key ? compare(a.value, b.value) : compare(a.key, b.key)))
    .map((entry) => `${rfc3986(entry.key)}=${rfc3986(entry.value)}`)
    .join("&");
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rfc3986(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.codePointAt(0)!.toString(16).toUpperCase()}`)
    .replace(/%7E/g, "~");
}
