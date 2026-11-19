/*
 * A `ReadableStream` body, in a real browser, against a real socket.
 *
 * Fetch upload streaming is not universal. A browser without it never reads
 * the `duplex` option and treats the stream as an ordinary object, so the body
 * goes out as its string form, `[object ReadableStream]`. A store accepts those
 * 23 bytes and answers 200, and the upload looks like it succeeded. A browser
 * with it may still refuse to stream over HTTP/1.1 and fail the fetch. The only
 * acceptable outcomes are the exact bytes arriving, or a rejection with nothing
 * stored.
 *
 * The store is the echo server from `_echo-server.ts`, plain HTTP/1.1. No
 * `contentLength` is declared, which is the case a store has no way to catch.
 */

import { expect, inject, it } from "vitest";

import { S3Client } from "../../src/index.ts";

/** The standard feature-detect for fetch upload streaming, reported with the outcome. */
function supportsRequestStreams(): boolean {
  let duplexAccessed = false;
  const hasContentType = new Request("http://localhost/", {
    body: new ReadableStream(),
    method: "POST",
    get duplex() {
      duplexAccessed = true;
      return "half" as const;
    },
  } as RequestInit).headers.has("Content-Type");
  return duplexAccessed && !hasContentType;
}

it("stores a streamed put byte for byte or rejects without storing anything", async () => {
  const origin = inject("echoOrigin");
  const client = new S3Client({
    region: "us-east-1",
    endpoint: origin,
    bucketStyle: "path",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
  });

  const text = "streamed through the browser";
  const key = `stream-${crypto.randomUUID()}.txt`;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

  const outcome = await client.put({ bucket: "bucket", key, body }).then(
    (response) => ({ status: response.status, error: undefined }),
    (error: unknown) => ({ status: undefined, error: String(error) }),
  );

  const stored = await fetch(`${origin}/bucket/${key}`);
  const received = stored.ok ? await stored.text() : undefined;

  /* The whole outcome goes into the comparison so a failure shows all of it. */
  const actual = { supportsRequestStreams: supportsRequestStreams(), ...outcome, received };
  expect(actual).toEqual({ ...actual, received: outcome.error === undefined ? text : undefined });
});
