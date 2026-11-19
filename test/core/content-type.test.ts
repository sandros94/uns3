import { describe, expect, it } from "vitest";

import { defaultContentTypeResolver, resolveContentType } from "../../src/core.ts";

describe("content type resolver", () => {
  it("prefers explicit content type", () => {
    expect(defaultContentTypeResolver("file.txt", "application/custom")).toBe("application/custom");
  });

  it("infers from key when explicit missing", () => {
    expect(defaultContentTypeResolver("photo.jpg")).toBe("image/jpeg");
  });

  it("never reads a name off the object prototype", () => {
    expect(defaultContentTypeResolver("x.constructor")).toBeUndefined();
    expect(defaultContentTypeResolver("x.__proto__")).toBeUndefined();
  });

  it("reads the extension of a key with ? or # in it", () => {
    expect(defaultContentTypeResolver("notes#1.txt")).toBe("text/plain");
    expect(defaultContentTypeResolver("report?v=1")).toBeUndefined();
  });

  it("can be overridden with custom resolver", () => {
    const resolver = (key: string) => (key.endsWith(".data") ? "application/x-data" : undefined);
    expect(resolveContentType("document.data", undefined, resolver)).toBe("application/x-data");
  });
});
