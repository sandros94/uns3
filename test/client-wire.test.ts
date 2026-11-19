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

import { presignUrl } from "../src/core.ts";
import { S3Client } from "../src/index.ts";
import { BUCKET, clientAnswering, credentials } from "./_client.ts";

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

    /* `|` sorts after `B`, but its encoding `%7C` sorts before it. */
    it("orders the signed query by its encoded names", async () => {
      const { client, requests } = clientAnswering(() => new Response("hi", { status: 200 }));

      await client.get({ bucket: BUCKET, key: "plain.txt", query: { "aB": "2", "a|": "1" } });

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

      expect(result.etag).toBe('"part-etag"');
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

    it("keeps a checksum the caller computed, even on a stream", async () => {
      const { client, requests } = clientAnswering(
        () => new Response(null, { status: 200, headers: { etag: '"part-etag"' } }),
        { checksum: { algorithm: "sha256", requireOnPut: true } },
      );

      await client.put({
        bucket: BUCKET,
        key: "streamed.bin",
        body: streamOf("payload"),
        headers: { "x-amz-checksum-sha256": "precomputed" },
      });

      expect(requests[0]!.headers.get("x-amz-checksum-sha256")).toBe("precomputed");
    });

    it("declares the algorithm on initiation when every part must carry it", async () => {
      const initiated = async (requireOnPut: boolean): Promise<string | null> => {
        const { client, requests } = clientAnswering(
          () =>
            new Response(
              "<InitiateMultipartUploadResult><UploadId>u</UploadId></InitiateMultipartUploadResult>",
            ),
          { checksum: { algorithm: "crc32c", requireOnPut } },
        );
        await client.initiateMultipart({ bucket: BUCKET, key: "big.bin" });
        return requests[0]!.headers.get("x-amz-checksum-algorithm");
      };

      await expect(initiated(true)).resolves.toBe("CRC32C");
      await expect(initiated(false)).resolves.toBeNull();
    });

    it("carries each part's checksum from its upload to the completion", async () => {
      const { client, requests } = clientAnswering(
        (request) =>
          request.method === "PUT"
            ? new Response(null, {
                status: 200,
                headers: { "etag": '"p1"', "x-amz-checksum-crc32c": "yZRlqg==" },
              })
            : new Response(
                "<CompleteMultipartUploadResult><ETag>&quot;e&quot;</ETag></CompleteMultipartUploadResult>",
              ),
        { checksum: { algorithm: "crc32c" } },
      );

      const part = await client.uploadPart({
        bucket: BUCKET,
        key: "big.bin",
        uploadId: "u",
        partNumber: 1,
        body: "part",
      });
      await client.completeMultipart({
        bucket: BUCKET,
        key: "big.bin",
        uploadId: "u",
        parts: [{ partNumber: 1, etag: part.etag, checksum: part.checksum }],
      });

      expect(part.checksum).toBe("yZRlqg==");
      await expect(requests[1]!.text()).resolves.toContain(
        "<ChecksumCRC32C>yZRlqg==</ChecksumCRC32C>",
      );
    });
  });

  /*
   * A payload is hashed once per request, not once per attempt, and a Blob too
   * large to hold is signed `UNSIGNED-PAYLOAD` rather than read into memory.
   */
  describe("payload hashing", () => {
    it("reads a Blob body once, however many attempts it takes", async () => {
      let attempts = 0;
      const { client, requests } = clientAnswering(
        () =>
          ++attempts === 1
            ? new Response("<Error><Code>InternalError</Code></Error>", { status: 500 })
            : new Response(null, { status: 200 }),
        { retry: { maxAttempts: 2, baseDelayMs: 0 } },
      );
      const body = new Blob(["payload"]);
      const read = vi.spyOn(body, "arrayBuffer");

      await client.put({ bucket: BUCKET, key: "a.bin", body });

      expect(requests).toHaveLength(2);
      expect(read).toHaveBeenCalledTimes(1);
      expect(signatureMatches(requests[1]!)).toBe(true);
    });

    it("signs a Blob too large to hold without reading it", async () => {
      const { client, requests } = clientAnswering(() => new Response(null, { status: 200 }));
      const body = new Blob([new Uint8Array(16 * 1024 * 1024 + 1)]);
      const read = vi.spyOn(body, "arrayBuffer");

      await client.put({ bucket: BUCKET, key: "big.bin", body });

      expect(read).not.toHaveBeenCalled();
      expect(requests[0]!.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
    });
  });

  /*
   * A presigned URL is handed to someone who sends nothing but the URL: a
   * browser, an `<img>`, `curl`. Everything the signature covers beyond `host`
   * therefore has to travel in the query, or the request that arrives is not
   * the one that was signed.
   */
  describe("presigned URLs", () => {
    it("carries a session token in the query only", async () => {
      const client = new S3Client({
        region: "us-east-1",
        endpoint: "https://s3.us-east-1.amazonaws.com",
        credentials: { ...credentials, sessionToken: "FQoGZXIvYXdzEXAMPLE//+token==" },
      });

      const url = new URL(await client.getSignedUrl({ method: "GET", bucket: BUCKET, key: "k" }));

      expect(url.searchParams.get("X-Amz-Security-Token")).toBe("FQoGZXIvYXdzEXAMPLE//+token==");
      expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
      expect(signatureMatches(new Request(url))).toBe(true);
    });

    /* Whoever holds the URL chooses the body, so there is no payload hash to sign. */
    it.each(["PUT", "get"] as const)("signs an unsigned payload for a %s", async (method) => {
      const { url } = await presignUrl({
        method,
        url: new URL("https://my-bucket.s3.us-east-1.amazonaws.com/k"),
        credentials,
        region: "us-east-1",
      });

      expect(signatureMatches(new Request(url, { method }))).toBe(true);
    });
  });

  /*
   * Hop-by-hop headers, and the others a proxy or runtime may add, drop or
   * rewrite in transit, are sent but not signed: a signature over them depends
   * on every hop between the client and the store.
   */
  describe("unsignable headers", () => {
    it("sends a user agent and a trace id without signing them", async () => {
      const { client, requests } = clientAnswering(() => new Response("hi", { status: 200 }));

      await client.get({
        bucket: BUCKET,
        key: "plain.txt",
        headers: { "user-agent": "my-app/1.0", "x-amzn-trace-id": "Root=1-5759e988-bd862e3fe1be" },
      });

      expect(requests[0]!.headers.get("user-agent")).toBe("my-app/1.0");
      expect(requests[0]!.headers.get("x-amzn-trace-id")).toBe("Root=1-5759e988-bd862e3fe1be");
      expect(requests[0]!.headers.get("authorization")).toContain(
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date,",
      );
      expect(signatureMatches(requests[0]!)).toBe(true);
    });
  });

  /*
   * A key is bytes; a URL path is not. See `test/core/endpoint.test.ts` for the
   * whole story — here the only question is whether the client refuses before it
   * writes somewhere the caller never named.
   */
  /*
   * The content type is the caller's first: the `contentType` parameter, then
   * a `content-type` header, then a Blob's own type. Only when none of them
   * says anything is it inferred from the key.
   */
  describe("content type", () => {
    const sent = async (params: Parameters<S3Client["put"]>[0]): Promise<string | null> => {
      const { client, requests } = clientAnswering(() => new Response(null, { status: 200 }));
      await client.put(params);
      return requests[0]!.headers.get("content-type");
    };

    it("keeps a content-type header over the one the key suggests", async () => {
      await expect(
        sent({ bucket: BUCKET, key: "a.json", body: "x", headers: { "content-type": "text/csv" } }),
      ).resolves.toBe("text/csv");
    });

    it("keeps a Blob's own type over the one the key suggests", async () => {
      const body = new Blob(["png"], { type: "image/png" });
      await expect(sent({ bucket: BUCKET, key: "photo.bin", body })).resolves.toBe("image/png");
    });

    it("sends no content type at all when told not to", async () => {
      await expect(
        sent({ bucket: BUCKET, key: "a.txt", body: "x", contentType: false }),
      ).resolves.toBeNull();
      await expect(
        sent({
          bucket: BUCKET,
          key: "a.txt",
          body: new Blob(["x"], { type: "text/plain" }),
          contentType: false,
        }),
      ).resolves.toBeNull();
    });

    it("sends none when nothing names one", async () => {
      await expect(
        sent({ bucket: BUCKET, key: "x.constructor", body: new Uint8Array([1]) }),
      ).resolves.toBeNull();
    });
  });

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

    it("presigns with the corrected clock too", async () => {
      const { client } = clientAnswering(() => new Response("ok", { status: 200 }), {
        clockSkewMs: 20 * 60 * 1000,
      });

      const url = new URL(await client.getSignedUrl({ method: "GET", bucket: BUCKET, key: "k" }));

      expect(url.searchParams.get("X-Amz-Date")).toBe("20230102T032405Z");
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

/**
 * Recomputes a request's signature from the bytes on the wire and compares it
 * with the `Authorization` header that was sent.
 *
 * This is deliberately written against the request rather than against the
 * client's own signer: it reads the raw query string, decodes it by RFC 3986
 * rules (where `+` is a plus, not a space, which is the whole point),
 * re-encodes, sorts the encoded pairs as the specification does, and derives
 * the signature with an independent HMAC. If the client signs one query and
 * sends another, the two signatures differ and this returns false — exactly as
 * a store would.
 *
 * A request without an `Authorization` header is read as a presigned URL: the
 * signing parameters come from the query, `X-Amz-Signature` is left out of the
 * canonical query, and the payload is `UNSIGNED-PAYLOAD`.
 */
function signatureMatches(request: Request): boolean {
  const url = new URL(request.url);
  const auth = request.headers.get("authorization");
  const presigned = !auth;

  const credential = presigned
    ? url.searchParams.get("X-Amz-Credential")
    : /Credential=([^,]+)/.exec(auth)?.[1];
  const signedHeaders = presigned
    ? url.searchParams.get("X-Amz-SignedHeaders")
    : /SignedHeaders=([^,]+)/.exec(auth)?.[1];
  const signature = presigned
    ? url.searchParams.get("X-Amz-Signature")
    : /Signature=([\da-f]+)/.exec(auth)?.[1];
  const amzDate = presigned
    ? url.searchParams.get("X-Amz-Date")
    : request.headers.get("x-amz-date");
  const payloadHash = presigned ? "UNSIGNED-PAYLOAD" : request.headers.get("x-amz-content-sha256");
  if (!credential || !signedHeaders || !signature) return false;

  const scope = credential.slice(credential.indexOf("/") + 1);
  const [shortDate, region, service] = scope.split("/");

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
    canonicalQuery(url.search, presigned ? "X-Amz-Signature" : undefined),
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash ?? "",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate ?? "",
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

function canonicalQuery(search: string, exclude?: string): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (!raw) return "";
  return raw
    .split("&")
    .map((pair) => {
      const separator = pair.indexOf("=");
      const key = separator === -1 ? pair : pair.slice(0, separator);
      const value = separator === -1 ? "" : pair.slice(separator + 1);
      return { key: rfc3986(decodeURIComponent(key)), value: rfc3986(decodeURIComponent(value)) };
    })
    .filter((entry) => entry.key !== exclude)
    .sort((a, b) => (a.key === b.key ? compare(a.value, b.value) : compare(a.key, b.key)))
    .map((entry) => `${entry.key}=${entry.value}`)
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
