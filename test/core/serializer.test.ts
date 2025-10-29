import { describe, expect, it } from "vitest";

import { applyQuery, createHeaders } from "../../src/core/serializer";

describe("serializer helpers", () => {
  it("merges headers and metadata", () => {
    const headers = createHeaders({
      headers: { "x-custom": "value" },
      contentType: "text/plain",
    });

    expect(headers.get("content-type")).toBe("text/plain");
    expect(headers.get("x-custom")).toBe("value");
  });

  it("applies query parameters including arrays", () => {
    const url = new URL("https://example.com");
    applyQuery(url, {
      prefix: "photos/",
      "max-keys": 100,
      marker: ["a", "b"],
      active: true,
    });

    expect(url.searchParams.getAll("marker")).toEqual(["a", "b"]);
    expect(url.searchParams.get("prefix")).toBe("photos/");
    expect(url.searchParams.get("max-keys")).toBe("100");
    expect(url.searchParams.get("active")).toBe("true");
  });
});
