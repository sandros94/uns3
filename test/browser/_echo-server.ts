/*
 * A stand-in for a store, run in Node by the `browser` project's globalSetup.
 *
 * It keeps the body of every PUT that arrives in full, answers 200, and hands
 * the stored bytes back on a GET of the same path, or 404 when no PUT got
 * through. That is all the browser leg needs to tell "the bytes arrived" from
 * "something else arrived" from "nothing arrived". The page is served from
 * another origin, so every response carries permissive CORS headers and the
 * preflight echoes back whatever headers the client asked to send.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    echoOrigin: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const stored = new Map<string, Buffer>();

  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-expose-headers", "etag");

    if (request.method === "OPTIONS") {
      response.setHeader("access-control-allow-methods", "GET, PUT");
      response.setHeader(
        "access-control-allow-headers",
        request.headers["access-control-request-headers"] ?? "*",
      );
      response.end();
      return;
    }

    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        stored.set(path, Buffer.concat(chunks));
        response.setHeader("etag", '"echo"');
        response.end();
      });
      return;
    }

    const body = stored.get(path);
    response.statusCode = body ? 200 : 404;
    response.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  project.provide("echoOrigin", `http://127.0.0.1:${port}`);

  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
