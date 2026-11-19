/*
 * When a request is sent again, and when it is not.
 *
 * Every request here is answered by the signal-honouring `fetch` mock in
 * `_client.ts`.
 */

import { describe, expect, it } from "vitest";

import { S3Client, S3Error } from "../src/index.ts";
import { BUCKET, clientAnswering, xmlError } from "./_client.ts";

describe("retry decision", () => {
  it("asks a custom predicate once per attempt, with the response it failed on", async () => {
    const calls: Array<[number | undefined, unknown]> = [];
    const { client, requests } = clientAnswering(() => xmlError(404, "NoSuchKey"), {
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        retriable: (response, error) => {
          calls.push([response?.status, error]);
          return response === undefined;
        },
      },
    });

    await expect(client.get({ bucket: BUCKET, key: "missing.txt" })).rejects.toMatchObject({
      status: 404,
      code: "NoSuchKey",
    });
    expect(requests).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(404);
    expect(calls[0]![1]).toBeInstanceOf(S3Error);
  });
});

/*
 * Whether a request may be sent again is a property of its body, not of its
 * method. Every S3 operation the client issues can be repeated safely — a PUT
 * or a DELETE is idempotent, and a repeated multipart initiate or complete is
 * what AWS itself recommends on a transient failure. A stream is the exception:
 * the attempt that sent it consumed it.
 */
describe("retry eligibility", () => {
  const operations: Array<[string, (client: S3Client) => Promise<unknown>]> = [
    ["put", (client) => client.put({ bucket: BUCKET, key: "a.txt", body: "payload" })],
    ["del", (client) => client.del({ bucket: BUCKET, key: "a.txt" })],
    [
      "uploadPart",
      (client) =>
        client.uploadPart({
          bucket: BUCKET,
          key: "a.bin",
          uploadId: "u",
          partNumber: 1,
          body: new Uint8Array([1, 2, 3]),
        }),
    ],
    ["initiateMultipart", (client) => client.initiateMultipart({ bucket: BUCKET, key: "a.bin" })],
  ];

  it.each(operations)("retries %s after a transient failure", async (_name, run) => {
    let attempts = 0;
    const { client, requests } = clientAnswering(
      () => {
        attempts += 1;
        if (attempts === 1) return xmlError(503, "SlowDown");
        return new Response(
          "<InitiateMultipartUploadResult><UploadId>u</UploadId></InitiateMultipartUploadResult>",
          { status: 200, headers: { etag: '"e"' } },
        );
      },
      { retry: { maxAttempts: 2, baseDelayMs: 0 } },
    );

    await run(client);

    expect(requests).toHaveLength(2);
    const [first, second] = await Promise.all(requests.map((request) => request.text()));
    expect(second).toBe(first);
  });

  it("does not retry a failure that is not transient", async () => {
    const { client, requests } = clientAnswering(() => xmlError(403, "AccessDenied"), {
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });

    await expect(client.put({ bucket: BUCKET, key: "a.txt", body: "x" })).rejects.toMatchObject({
      status: 403,
    });
    expect(requests).toHaveLength(1);
  });

  it("never retries a streamed body, whatever the predicate says", async () => {
    const { client, requests } = clientAnswering(() => xmlError(500, "InternalError"), {
      retry: { maxAttempts: 3, baseDelayMs: 0, retriable: () => true },
    });

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("one shot"));
        controller.close();
      },
    });

    /* The original 500 surfaces, rather than a `TypeError` about a used body. */
    await expect(client.put({ bucket: BUCKET, key: "s.bin", body })).rejects.toMatchObject({
      status: 500,
      code: "InternalError",
    });
    expect(requests).toHaveLength(1);
  });
});

describe("retry configuration", () => {
  it("fills in what a partial configuration leaves out", async () => {
    let attempts = 0;
    const { client, requests } = clientAnswering(
      () => (++attempts === 1 ? xmlError(500, "InternalError") : new Response("ok")),
      { retry: { baseDelayMs: 0 } },
    );

    await client.get({ bucket: BUCKET, key: "a.txt" });

    expect(requests).toHaveLength(2);
  });

  it.each([Number.NaN, 0, 1.5, -1, Infinity])("refuses maxAttempts %s", (maxAttempts) => {
    expect(
      () => new S3Client({ endpoint: "https://s3.example.com", retry: { maxAttempts } }),
    ).toThrow(RangeError);
  });

  it.each([Number.NaN, -1, Infinity])("refuses baseDelayMs %s", (baseDelayMs) => {
    expect(
      () => new S3Client({ endpoint: "https://s3.example.com", retry: { baseDelayMs } }),
    ).toThrow(RangeError);
  });
});

describe("aborting", () => {
  it("stops with the caller's own abort reason, whatever it is", async () => {
    const controller = new AbortController();
    const { client, requests } = clientAnswering(() => new Promise<Response>(() => {}), {
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });

    const promise = client.get({ bucket: BUCKET, key: "slow.txt", signal: controller.signal });
    controller.abort("stop");

    await expect(promise).rejects.toBe("stop");
    expect(requests).toHaveLength(1);
  });

  it("does not retry a request whose signal timed out", async () => {
    const { client, requests } = clientAnswering(() => new Promise<Response>(() => {}), {
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });

    const promise = client.get({ bucket: BUCKET, key: "slow.txt", signal: AbortSignal.timeout(5) });

    await expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
    expect(requests).toHaveLength(1);
  });

  it("stops while reading an error body, rather than reporting a partial error", async () => {
    const controller = new AbortController();
    const { client } = clientAnswering(
      (request) =>
        new Response(endlessBody("<Error><Code>AccessDenied</Code>", request.signal), {
          status: 403,
        }),
    );

    const promise = client.get({ bucket: BUCKET, key: "denied.txt", signal: controller.signal });
    setTimeout(() => controller.abort("stop"), 5);

    await expect(promise).rejects.toBe("stop");
  });
});

/** A body that sends `head`, then never ends until the signal aborts it. */
/*
 * Nothing waits forever. A request that moves no object bytes has a deadline
 * per attempt, an error body has one whatever the request, and no delay
 * between attempts outlasts `maxDelayMs`, whatever the store asks for. A
 * request that moves object bytes (`get`, `put`, `uploadPart`) has no default
 * deadline, since a large transfer has no honest one, but takes `timeoutMs`.
 */
describe("deadlines", () => {
  const never = (): Promise<Response> => new Promise<Response>(() => {});

  it("times out and retries a request that moves no object bytes", async () => {
    const { client, requests } = clientAnswering(never, {
      timeoutMs: 20,
      retry: { maxAttempts: 2, baseDelayMs: 0 },
    });

    await expect(client.head({ bucket: BUCKET, key: "a.txt" })).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(requests).toHaveLength(2);
  });

  it("gives a request that moves object bytes no default deadline", async () => {
    const controller = new AbortController();
    const { client } = clientAnswering(never, { timeoutMs: 20 });

    const pending = client.get({ bucket: BUCKET, key: "a.txt", signal: controller.signal });
    const outcome = await Promise.race([
      pending.then(
        () => "settled",
        () => "settled",
      ),
      new Promise((resolve) => setTimeout(resolve, 60, "pending")),
    ]);
    controller.abort();
    await pending.catch(() => {});

    expect(outcome).toBe("pending");
  });

  it("bounds an attempt to its response, never the body read after it", async () => {
    const { client } = clientAnswering((request) => new Response(lateBody("late", request.signal)));

    const response = await client.get({ bucket: BUCKET, key: "a.txt", timeoutMs: 20 });

    await expect(response.text()).resolves.toBe("late");
  });

  it("bounds an error body that never ends", async () => {
    const { client } = clientAnswering(
      (request) =>
        new Response(endlessBody("<Error><Code>AccessDenied</Code>", request.signal), {
          status: 403,
        }),
      { timeoutMs: 20 },
    );

    await expect(client.put({ bucket: BUCKET, key: "a.txt", body: "x" })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("caps a Retry-After at maxDelayMs", async () => {
    let attempts = 0;
    const { client, requests } = clientAnswering(
      () =>
        ++attempts === 1
          ? new Response(null, { status: 503, headers: { "retry-after": "86400" } })
          : new Response("ok"),
      { retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 10 } },
    );

    await client.get({ bucket: BUCKET, key: "a.txt" });

    expect(requests).toHaveLength(2);
  });

  it.each([
    [{ "retry-after": "1e6" }, undefined],
    [{ "retry-after": "0x10" }, undefined],
    [{ "retry-after": "120" }, 120],
    [{ "x-amz-retry-after": "1500" }, 1.5],
  ])("reads %j as a retryAfter of %s seconds", async (headers, retryAfter) => {
    const { client } = clientAnswering(() => new Response(null, { status: 503, headers }));

    await expect(client.head({ bucket: BUCKET, key: "a.txt" })).rejects.toMatchObject({
      retryAfter,
    });
  });

  it.each([0, -1, Number.NaN, Infinity, 2 ** 31])("refuses timeoutMs %s", (timeoutMs) => {
    expect(() => new S3Client({ endpoint: "https://s3.example.com", timeoutMs })).toThrow(
      RangeError,
    );
  });

  it.each([-1, Number.NaN, Infinity, 2 ** 31])("refuses maxDelayMs %s", (maxDelayMs) => {
    expect(
      () => new S3Client({ endpoint: "https://s3.example.com", retry: { maxDelayMs } }),
    ).toThrow(RangeError);
  });
});

/** A body that arrives in full, 50ms after the response did. */
function lateBody(text: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      }, 50);
    },
  });
}

function endlessBody(head: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(head));
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  });
}
