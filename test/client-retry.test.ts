/*
 * When a request is sent again, and when it is not.
 *
 * Every request here is answered by a `fetch` mock that honours the signal the
 * way a real one does: an aborted signal rejects the pending fetch, and the
 * body read, with the signal's own reason.
 */

import { describe, expect, it } from "vitest";

import { type Credentials, S3Client, S3Error } from "../src/index.ts";

const credentials: Credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

const BUCKET = "my-bucket";

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

function xmlError(status: number, code: string): Response {
  return new Response(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`, {
    status,
  });
}

/** A body that sends `head`, then never ends until the signal aborts it. */
function endlessBody(head: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(head));
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  });
}

/**
 * A client whose every request is answered by `responder`, and kept. The
 * request's signal rejects a pending answer the way `fetch` does.
 */
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
      const signal = init?.signal ?? request.signal;
      signal.throwIfAborted();
      return await new Promise<Response>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        Promise.resolve(responder(request)).then(resolve, reject);
      });
    }) as typeof fetch,
  });
  return { client, requests };
}
