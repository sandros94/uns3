/*
 * The public surface, entry by entry. Every subpath is one module with one job,
 * so a consumer downloads what it imports and nothing else, and anything not
 * listed here is internal.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const entries = {
  ".": ["S3Client", "S3Error"],
  "./signer": ["SigningKeyCache", "presignUrl", "sharedSigningKeyCache", "signRequest"],
  "./endpoint": ["buildRequestUrl", "encodeS3Key"],
  "./mime": ["common", "createContentTypeResolver"],
};

const sources: Record<keyof typeof entries, string> = {
  ".": "../src/index.ts",
  "./signer": "../src/signer.ts",
  "./endpoint": "../src/endpoint.ts",
  "./mime": "../src/mime.ts",
};

describe("package exports", () => {
  it.each(Object.entries(entries))("%s exports exactly its own values", async (entry, names) => {
    const module = (await import(sources[entry as keyof typeof entries])) as object;
    expect(Object.keys(module).sort()).toEqual([...names].sort());
  });

  it("maps every subpath, types first, and nothing else", () => {
    const { exports } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports: Record<string, string | Record<string, string>>;
    };

    expect(Object.keys(exports).sort()).toEqual(
      [...Object.keys(entries), "./mime/*", "./package.json"].sort(),
    );
    for (const [subpath, target] of Object.entries(exports)) {
      if (subpath === "./package.json") continue;
      expect(Object.keys(target)).toEqual(["types", "default"]);
    }
  });
});
