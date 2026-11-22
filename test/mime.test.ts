/*
 * Content types are inferred from tables the application picks, so a bundle
 * carries the groups it uses and nothing else.
 */

import { describe, expect, it } from "vitest";

import { common, createContentTypeResolver } from "../src/mime.ts";
import all from "../src/mime/all.ts";
import archive from "../src/mime/archive.ts";
import audio from "../src/mime/audio.ts";
import data from "../src/mime/data.ts";
import document from "../src/mime/document.ts";
import font from "../src/mime/font.ts";
import image from "../src/mime/image.ts";
import model from "../src/mime/model.ts";
import video from "../src/mime/video.ts";
import web from "../src/mime/web.ts";

const groups = { web, image, audio, video, font, document, data, archive, model };

/* RFC 6838 restricted names, with optional parameters after a `;`. */
const MEDIA_TYPE = /^[a-z0-9][\w!#$&^.+-]*\/[a-z0-9][\w!#$&^.+-]*(?:\s*;.*)?$/i;

describe("createContentTypeResolver", () => {
  it("infers from the last extension of a key, whatever its case", () => {
    const resolve = createContentTypeResolver(image);

    expect(resolve("photos/2024/Holiday.PNG")).toBe("image/png");
    expect(resolve("archive.tar.jpg")).toBe("image/jpeg");
  });

  it("infers nothing it was not given", () => {
    const resolve = createContentTypeResolver(image);

    expect(resolve("song.mp3")).toBeUndefined();
    expect(resolve("README")).toBeUndefined();
    expect(resolve("dir.v2/file")).toBeUndefined();
    expect(resolve("x.constructor")).toBeUndefined();
    expect(resolve("x.__proto__")).toBeUndefined();
  });

  it("keeps an explicit type, and infers none when told not to", () => {
    const resolve = createContentTypeResolver(image);

    expect(resolve("photo.png", "image/x-custom")).toBe("image/x-custom");
    expect(resolve("photo.png", false)).toBeUndefined();
  });

  it("lets a later table win, and takes the application's own entries", () => {
    const resolve = createContentTypeResolver(video, {
      "ts": "text/typescript",
      ".HEIC": "image/heic",
    });

    expect(resolve("main.ts")).toBe("text/typescript");
    expect(resolve("photo.heic")).toBe("image/heic");
    expect(resolve("clip.mp4")).toBe("video/mp4");
  });

  it("refuses an entry that is not a media type", () => {
    expect(() => createContentTypeResolver({ txt: "plain" })).toThrow(TypeError);
    expect(() => createContentTypeResolver({ txt: 1 as never })).toThrow(TypeError);
  });

  it("takes parameters along with a type", () => {
    const resolve = createContentTypeResolver({ txt: "text/plain; charset=utf-8" });

    expect(resolve("notes.txt")).toBe("text/plain; charset=utf-8");
  });
});

describe("groups", () => {
  it.each(Object.entries({ ...groups, common, all }))(
    "%s maps lowercase extensions to media types, and cannot be changed",
    (_name, table) => {
      for (const [extension, type] of Object.entries(table)) {
        expect(extension).toMatch(/^[a-z0-9][a-z0-9+_-]*$/);
        expect(type).toMatch(MEDIA_TYPE);
      }
      expect(Object.isFrozen(table)).toBe(true);
    },
  );

  it("never disagree with each other", () => {
    const seen = new Map<string, string>();
    for (const table of [common, ...Object.values(groups)]) {
      for (const [extension, type] of Object.entries(table)) {
        expect(seen.get(extension) ?? type).toBe(type);
        seen.set(extension, type);
      }
    }
  });

  it("are exported by name and as the default alike", async () => {
    for (const name of [...Object.keys(groups), "common", "all"]) {
      const module = (await import(`../src/mime/${name}.ts`)) as Record<string, unknown>;
      expect(module[name]).toBe(module.default);
    }
  });

  it("name data files by their registered types", () => {
    const resolve = createContentTypeResolver(data);

    expect(resolve("events/2024.parquet")).toBe("application/vnd.apache.parquet");
    expect(resolve("table.arrow")).toBe("application/vnd.apache.arrow.file");
    expect(resolve("config.yaml")).toBe("application/yaml");
    expect(resolve("config.yml")).toBe("application/yaml");
    expect(resolve("zones.geojson")).toBe("application/geo+json");
  });

  it("are all part of all", () => {
    for (const table of [common, ...Object.values(groups)]) {
      expect(all).toMatchObject(table);
    }
  });
});
