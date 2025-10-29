import { describe, expect, it } from "vitest";

import {
  defaultContentTypeResolver,
  resolveContentType,
} from "../../src/core/content-type";

describe("content type resolver", () => {
  it("prefers explicit content type", () => {
    expect(defaultContentTypeResolver("file.txt", "application/custom")).toBe(
      "application/custom",
    );
  });

  it("infers from key when explicit missing", () => {
    expect(defaultContentTypeResolver("photo.jpg")).toBe("image/jpeg");
  });

  it("can be overridden with custom resolver", () => {
    const resolver = (key: string) =>
      key.endsWith(".data") ? "application/x-data" : undefined;
    expect(resolveContentType("document.data", undefined, resolver)).toBe(
      "application/x-data",
    );
  });
});
