/*
 * The client every mocked suite talks through: a real `S3Client` whose `fetch`
 * keeps each request it is handed and answers it with `responder`.
 *
 * The mock honours the signal the way a real `fetch` does. An aborted signal
 * rejects the pending answer with the signal's own reason.
 */

import { type Credentials, S3Client, type S3ClientConfig } from "../src/index.ts";

export const credentials: Credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

export const BUCKET = "my-bucket";

/** A client whose every request is answered by `responder`, and kept. */
export function clientAnswering(
  responder: (request: Request) => Response | Promise<Response>,
  config: Partial<S3ClientConfig> = {},
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

/** An S3 error document with `code` as both its code and its message. */
export function xmlError(status: number, code: string): Response {
  return new Response(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`, {
    status,
  });
}
