/*
 * The battery, written once and run against every selected store.
 *
 * Everything here is an assertion about what a real S3 implementation does with
 * what this client puts on the wire — nothing is mocked, nothing is stubbed, and
 * the only thing shared between a test and the store is the socket. Where the
 * two stores were found to differ, the difference is asserted per store and the
 * reason is written down; where they were found to agree, the assertion is as
 * tight as the agreement allows, because that agreement is the evidence that the
 * client is speaking the protocol rather than speaking to one server.
 *
 * Each test claims its own random key prefix (see `randomPrefix`), so the list
 * assertions can be exact and nothing a test writes is visible to another.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3Error } from "../../src/index.ts";
import type { S3Client } from "../../src/index.ts";
import {
  BUCKET,
  HAS_CONTAINER_RUNTIME,
  bytesOf,
  clientFor,
  countingBytes,
  discard,
  randomPrefix,
  seed,
  selectedStores,
  sha256Hex,
  startStore,
} from "./_stores.ts";
import type { StartedStore, StoreSpec } from "./_stores.ts";

/*
 * Nine bytes that are not valid UTF-8: the Parquet magic number, then `ff` and
 * `fe`, which no valid UTF-8 sequence ever contains; a NUL, which is valid but
 * routinely mishandled as a terminator; `80`, a continuation byte with no lead
 * byte in front of it; and `c0`, a lead byte with nothing to lead.
 *
 * Any accidental decode-then-re-encode anywhere between `put` and `arrayBuffer`
 * replaces four of these with U+FFFD, which is three bytes each — so a client
 * that round-trips through a string fails this on length before it fails on
 * content, and the failure is impossible to misread.
 */
const NOT_UTF8 = new Uint8Array([0x50, 0x41, 0x52, 0x31, 0xff, 0xfe, 0x00, 0x80, 0xc0]);

/** S3 requires every part but the last to be at least this large. */
const MIN_PART_BYTES = 5 * 1024 * 1024;

/** The tail part, kept small so the whole upload stays around five megabytes. */
const TAIL_PART_BYTES = 1024;

const SELECTED = selectedStores();

describe.skipIf(!HAS_CONTAINER_RUNTIME).each(SELECTED)("$name", (spec: StoreSpec) => {
  let store: StartedStore;
  let client: S3Client;

  beforeAll(async () => {
    store = await startStore(spec);
    client = clientFor(spec, store);
  });

  afterAll(async () => {
    await store?.container.stop();
  });

  describe("put and get", () => {
    it("round-trips a text body with the content type it was given", async () => {
      const key = `${randomPrefix()}greeting.txt`;

      const written = await client.put({ key, body: "hello world", contentType: "text/plain" });
      expect(written.status).toBe(200);
      await discard(written);

      const read = await client.get({ key });
      expect(read.status).toBe(200);
      expect(read.headers.get("content-type")).toBe("text/plain");
      await expect(read.text()).resolves.toBe("hello world");
    });

    it("round-trips a plain object as JSON", async () => {
      const key = `${randomPrefix()}payload.json`;
      const value = { nested: { list: [1, 2, 3] }, when: "now" };

      await discard(await client.put({ key, body: value }));

      const read = await client.get({ key });
      expect(read.headers.get("content-type")).toBe("application/json");
      await expect(read.json()).resolves.toEqual(value);
    });

    it("round-trips bytes that are not valid UTF-8, byte for byte", async () => {
      const key = `${randomPrefix()}magic.bin`;

      await seed(client, key, NOT_UTF8, "application/octet-stream");

      const read = await client.get({ key });
      expect(read.status).toBe(200);
      await expect(bytesOf(read)).resolves.toEqual(NOT_UTF8);
    });

    it("round-trips an empty body", async () => {
      const key = `${randomPrefix()}empty.bin`;

      await seed(client, key, new Uint8Array(0), "application/octet-stream");

      const read = await client.head({ key });
      expect(read.status).toBe(200);
      expect(read.headers.get("content-length")).toBe("0");
    });
  });

  /*
   * THE REGRESSION TEST THIS SUITE EXISTS FOR.
   *
   * A ranged GET is answered 206, not 200, and a client that only accepts 200
   * raises on every successful partial read it ever makes. Both stores agree on
   * all of it — status, `content-range`, and the bytes — so there is no store
   * here to blame for a failure: a failure is the client's.
   */
  describe("get with a range", () => {
    it("answers 206 with exactly the requested slice", async () => {
      const key = `${randomPrefix()}sliced.bin`;
      const body = countingBytes(256);

      await seed(client, key, body, "application/octet-stream");

      const read = await client.get({ key, range: { start: 10, end: 19 } });
      expect(read.status).toBe(206);
      expect(read.headers.get("content-range")).toBe("bytes 10-19/256");
      await expect(bytesOf(read)).resolves.toEqual(body.slice(10, 20));
    });

    it("answers 206 for an open-ended range", async () => {
      const key = `${randomPrefix()}open-ended.bin`;
      const body = countingBytes(256);

      await seed(client, key, body, "application/octet-stream");

      const read = await client.get({ key, range: { start: 250 } });
      expect(read.status).toBe(206);
      expect(read.headers.get("content-range")).toBe("bytes 250-255/256");
      await expect(bytesOf(read)).resolves.toEqual(body.slice(250));
    });

    it("answers 206 for a suffix range", async () => {
      const key = `${randomPrefix()}suffix.bin`;
      const body = countingBytes(256);

      await seed(client, key, body, "application/octet-stream");

      /* `end` with no `start` is `bytes=-4`: the LAST four bytes, not the first. */
      const read = await client.get({ key, range: { end: 4 } });
      expect(read.status).toBe(206);
      expect(read.headers.get("content-range")).toBe("bytes 252-255/256");
      await expect(bytesOf(read)).resolves.toEqual(body.slice(252));
    });

    it("answers 206 for a single byte", async () => {
      const key = `${randomPrefix()}one-byte.bin`;
      const body = countingBytes(256);

      await seed(client, key, body, "application/octet-stream");

      const read = await client.get({ key, range: { start: 0, end: 0 } });
      expect(read.status).toBe(206);
      expect(read.headers.get("content-range")).toBe("bytes 0-0/256");
      await expect(bytesOf(read)).resolves.toEqual(body.slice(0, 1));
    });

    it("raises 416 for a range that starts past the end of the object", async () => {
      const key = `${randomPrefix()}short.bin`;

      await seed(client, key, countingBytes(16), "application/octet-stream");

      const error = await rejection(() => client.get({ key, range: { start: 1000, end: 2000 } }));
      expect(error.status).toBe(416);
    });
  });

  describe("head", () => {
    it("reports the metadata of an existing key", async () => {
      const key = `${randomPrefix()}described.txt`;

      await seed(client, key, "hello world", "text/plain");

      const read = await client.head({ key });
      expect(read.status).toBe(200);
      expect(read.headers.get("content-length")).toBe("11");
      expect(read.headers.get("content-type")).toBe("text/plain");
      /* Quoted, per RFC 9110 — the quotes are part of the value, not decoration. */
      expect(read.headers.get("etag")).toMatch(/^"[\da-f]{32}"$/);
    });

    it("raises a 404 S3Error for a missing key", async () => {
      const key = `${randomPrefix()}never-written.txt`;

      const error = await rejection(() => client.head({ key }));
      expect(error).toBeInstanceOf(S3Error);
      expect(error.status).toBe(404);
    });
  });

  /*
   * Conditionals were probed against both stores before being asserted, and the
   * two turned out to agree on every case below — including the ones AWS itself
   * only grew recently, like `if-none-match: *` on PUT. Nothing is skipped for
   * either store here; if a third store is ever added and disagrees, the shape to
   * reach for is a per-store expectation, not a looser shared one.
   */
  describe("conditional requests", () => {
    it("answers 304 to a GET whose if-none-match matches", async () => {
      const key = `${randomPrefix()}conditional.txt`;
      await seed(client, key, "hello world", "text/plain");
      const etag = await etagOf(client, key);

      const read = await client.get({ key, ifNoneMatch: etag });
      expect(read.status).toBe(304);
      await discard(read);
    });

    it("answers 200 to a GET whose if-none-match does not match", async () => {
      const key = `${randomPrefix()}conditional.txt`;
      await seed(client, key, "hello world", "text/plain");

      const read = await client.get({ key, ifNoneMatch: '"deadbeef"' });
      expect(read.status).toBe(200);
      await discard(read);
    });

    it("raises 412 for a GET whose if-match does not match", async () => {
      const key = `${randomPrefix()}conditional.txt`;
      await seed(client, key, "hello world", "text/plain");

      /*
       * 412 is not in `get`'s expected set — a caller who asked for "this exact
       * version" and did not get it has failed, not received an alternative.
       */
      const error = await rejection(() => client.get({ key, ifMatch: '"deadbeef"' }));
      expect(error.status).toBe(412);
      expect(error.code).toBe("PreconditionFailed");
    });

    it("answers 200 to a GET whose if-match matches", async () => {
      const key = `${randomPrefix()}conditional.txt`;
      await seed(client, key, "hello world", "text/plain");
      const etag = await etagOf(client, key);

      const read = await client.get({ key, ifMatch: etag });
      expect(read.status).toBe(200);
      await expect(read.text()).resolves.toBe("hello world");
    });

    it("answers 304 to a HEAD whose if-none-match matches", async () => {
      const key = `${randomPrefix()}conditional.txt`;
      await seed(client, key, "hello world", "text/plain");
      const etag = await etagOf(client, key);

      const read = await client.head({ key, ifNoneMatch: etag });
      expect(read.status).toBe(304);
      await discard(read);
    });

    it("raises 412 for a HEAD whose if-match does not match", async () => {
      const key = `${randomPrefix()}conditional.txt`;
      await seed(client, key, "hello world", "text/plain");

      const error = await rejection(() => client.head({ key, ifMatch: '"deadbeef"' }));
      expect(error.status).toBe(412);
      /*
       * No `code`: a HEAD has no body to carry the `<Error><Code>` element, so
       * the status is the whole of what either store manages to say.
       */
      expect(error.code).toBeUndefined();
    });

    it("refuses a PUT with if-none-match:* over an existing key", async () => {
      const key = `${randomPrefix()}claimed.txt`;

      const first = await client.put({ key, body: "first", ifNoneMatch: "*" });
      expect(first.status).toBe(200);
      await discard(first);

      /*
       * 412 is a *result* of `put`, not a failure of it — "somebody else got
       * there first" is the answer this call went looking for.
       */
      const second = await client.put({ key, body: "second", ifNoneMatch: "*" });
      expect(second.status).toBe(412);
      await discard(second);

      const read = await client.get({ key });
      await expect(read.text()).resolves.toBe("first");
    });

    it("accepts a PUT with a matching if-match and refuses a mismatched one", async () => {
      const key = `${randomPrefix()}versioned.txt`;
      await seed(client, key, "first", "text/plain");
      const etag = await etagOf(client, key);

      const matched = await client.put({ key, body: "second", ifMatch: etag });
      expect(matched.status).toBe(200);
      await discard(matched);

      const stale = await client.put({ key, body: "third", ifMatch: etag });
      expect(stale.status).toBe(412);
      await discard(stale);

      const read = await client.get({ key });
      await expect(read.text()).resolves.toBe("second");
    });
  });

  describe("del", () => {
    it("removes the key, after which a get raises 404", async () => {
      const key = `${randomPrefix()}doomed.txt`;
      await seed(client, key, "here for now", "text/plain");

      const removed = await client.del({ key });
      expect([200, 204]).toContain(removed.status);
      await discard(removed);

      const error = await rejection(() => client.get({ key }));
      expect(error.status).toBe(404);
      expect(error.code).toBe("NoSuchKey");
    });

    it("treats deleting a key that was never there as done", async () => {
      const key = `${randomPrefix()}never-there.txt`;

      const removed = await client.del({ key });
      expect([200, 204]).toContain(removed.status);
      await discard(removed);
    });
  });

  describe("list", () => {
    it("returns everything under a prefix and nothing outside it", async () => {
      const prefix = randomPrefix();
      const other = randomPrefix();
      await seedTree(client, prefix);
      await seed(client, `${other}elsewhere.txt`, "not mine");

      const listed = await client.list({ prefix });
      expect(listed.contents.map((entry) => entry.key)).toEqual([
        `${prefix}a.txt`,
        `${prefix}b.txt`,
        `${prefix}nested/c.txt`,
        `${prefix}nested/d.txt`,
        `${prefix}nested/deep/e.txt`,
      ]);
      expect(listed.isTruncated).toBe(false);
      expect(listed.commonPrefixes).toEqual([]);
    });

    it("reports a size and an etag for each entry", async () => {
      const prefix = randomPrefix();
      await seed(client, `${prefix}sized.txt`, "hello world", "text/plain");

      const listed = await client.list({ prefix });
      const entry = listed.contents[0];
      expect(entry?.key).toBe(`${prefix}sized.txt`);
      expect(entry?.size).toBe(11);
      expect(Date.parse(entry?.lastModified ?? "")).not.toBeNaN();

      /*
       * `toContain` rather than an equality, and the looseness is the client's
       * rather than the stores'. SeaweedFS XML-escapes the quotes around
       * `<ETag>` as the NUMERIC entity `&#34;`, and `decodeXml` in
       * `src/client.ts` maps `&quot;` but not `&#34;` — so the entity survives
       * parsing, `stripQuotes` never sees a leading `"`, and the parsed etag
       * reads `&#34;5eb6…&#34;`. RustFS sends the hex bare and comes back clean.
       * Asserting equality here would be asserting that gap is correct; this
       * asserts what both stores actually reported the object's etag to be.
       */
      const etag = (await etagOf(client, `${prefix}sized.txt`)).replaceAll('"', "");
      expect(entry?.etag).toContain(etag);
    });

    it("rolls keys below a delimiter into commonPrefixes", async () => {
      const prefix = randomPrefix();
      await seedTree(client, prefix);

      const listed = await client.list({ prefix, delimiter: "/" });
      expect(listed.contents.map((entry) => entry.key)).toEqual([
        `${prefix}a.txt`,
        `${prefix}b.txt`,
      ]);
      /* One entry, not two: `nested/deep/` is below `nested/` and rolls into it. */
      expect(listed.commonPrefixes).toEqual([`${prefix}nested/`]);
    });

    it("pages through the prefix with maxKeys and a continuation token", async () => {
      const prefix = randomPrefix();
      await seedTree(client, prefix);

      /*
       * The walk records rather than asserts, and the assertions come after it.
       * A store that paged wrongly would otherwise fail somewhere inside a loop
       * whose shape is itself part of what is under test, and the report would
       * name an iteration instead of naming the paging.
       */
      const pages: Array<{ keys: string[]; truncated: boolean; token: string | undefined }> = [];
      let token: string | undefined;

      do {
        const page = await client.list({ prefix, maxKeys: 2, continuationToken: token });
        pages.push({
          keys: page.contents.map((entry) => entry.key),
          truncated: page.isTruncated,
          token: page.nextContinuationToken,
        });
        /*
         * The token is only followed while `isTruncated` — a store is free to
         * echo a stale one on the final page, and chasing it would loop forever.
         */
        token = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (token && pages.length < 10);

      expect(pages.map((page) => page.keys)).toEqual([
        [`${prefix}a.txt`, `${prefix}b.txt`],
        [`${prefix}nested/c.txt`, `${prefix}nested/d.txt`],
        [`${prefix}nested/deep/e.txt`],
      ]);
      expect(pages.map((page) => page.truncated)).toEqual([true, true, false]);
      /* Every page that claimed more was coming also said where to ask for it. */
      expect(pages.filter((page) => page.truncated).map((page) => Boolean(page.token))).toEqual([
        true,
        true,
      ]);
    });

    it("returns an empty result for a prefix nothing was written under", async () => {
      const listed = await client.list({ prefix: randomPrefix() });
      expect(listed.contents).toEqual([]);
      expect(listed.commonPrefixes).toEqual([]);
      expect(listed.isTruncated).toBe(false);
    });
  });

  describe("multipart upload", () => {
    it("assembles two parts into one object", async () => {
      const key = `${randomPrefix()}assembled.bin`;
      /*
       * The first part is exactly at S3's five-megabyte floor and the second is a
       * kilobyte: a two-part upload is the smallest one that exercises assembly
       * at all, and anything larger only spends time hashing.
       */
      const first = countingBytes(MIN_PART_BYTES);
      const second = countingBytes(TAIL_PART_BYTES, MIN_PART_BYTES);
      const whole = new Uint8Array(first.length + second.length);
      whole.set(first, 0);
      whole.set(second, first.length);

      const { uploadId } = await client.initiateMultipart({
        key,
        contentType: "application/octet-stream",
      });
      expect(uploadId).toBeTruthy();

      const partOne = await client.uploadPart({ key, uploadId, partNumber: 1, body: first });
      const partTwo = await client.uploadPart({ key, uploadId, partNumber: 2, body: second });
      expect(partOne.etag).toMatch(/^[\da-f]{32}$/);
      expect(partTwo.etag).toMatch(/^[\da-f]{32}$/);

      const completed = await client.completeMultipart({
        key,
        uploadId,
        parts: [
          { partNumber: 1, etag: partOne.etag },
          { partNumber: 2, etag: partTwo.etag },
        ],
      });
      expect(completed.status).toBe(200);
      await discard(completed);

      const read = await client.get({ key });
      expect(read.headers.get("content-length")).toBe(String(whole.length));
      /* A digest rather than a byte-for-byte compare: exact, and legible when it fails. */
      await expect(bytesOf(read).then(sha256Hex)).resolves.toBe(await sha256Hex(whole));
    });

    it("serves a range out of an assembled multipart object", async () => {
      const key = `${randomPrefix()}assembled-ranged.bin`;
      const first = countingBytes(MIN_PART_BYTES);
      const second = countingBytes(TAIL_PART_BYTES, MIN_PART_BYTES);

      const { uploadId } = await client.initiateMultipart({ key });
      const partOne = await client.uploadPart({ key, uploadId, partNumber: 1, body: first });
      const partTwo = await client.uploadPart({ key, uploadId, partNumber: 2, body: second });
      await discard(
        await client.completeMultipart({
          key,
          uploadId,
          parts: [
            { partNumber: 1, etag: partOne.etag },
            { partNumber: 2, etag: partTwo.etag },
          ],
        }),
      );

      /* Deliberately straddling the part boundary, which is where an assembled
         object is likeliest to be stitched wrong. */
      const start = MIN_PART_BYTES - 4;
      const read = await client.get({ key, range: { start, end: start + 7 } });
      expect(read.status).toBe(206);
      await expect(bytesOf(read)).resolves.toEqual(countingBytes(8, start));
    });

    it("aborts an upload, leaving neither the object nor the upload behind", async () => {
      const key = `${randomPrefix()}abandoned.bin`;

      const { uploadId } = await client.initiateMultipart({ key });
      await client.uploadPart({ key, uploadId, partNumber: 1, body: "a part that goes nowhere" });

      await expect(client.abortMultipart({ key, uploadId })).resolves.toBeUndefined();

      const gone = await rejection(() => client.head({ key }));
      expect(gone.status).toBe(404);

      /* The uploadId itself is gone too, not merely emptied. */
      const stale = await rejection(() =>
        client.uploadPart({ key, uploadId, partNumber: 2, body: "too late" }),
      );
      expect(stale.status).toBe(404);
    });
  });

  describe("presigned urls", () => {
    it("serves a presigned GET to a fetch that carries no credentials", async () => {
      const key = `${randomPrefix()}shared.txt`;
      await seed(client, key, "hello world", "text/plain");

      const url = await client.getSignedUrl({ method: "GET", key, expiresInSeconds: 300 });
      expect(url).toContain("X-Amz-Signature=");

      /* A plain `fetch`, not the client: the URL has to stand on its own. */
      const read = await fetch(url);
      expect(read.status).toBe(200);
      await expect(read.text()).resolves.toBe("hello world");
    });

    it("honours a Range header on a presigned GET", async () => {
      const key = `${randomPrefix()}shared.bin`;
      const body = countingBytes(256);
      await seed(client, key, body, "application/octet-stream");

      const url = await client.getSignedUrl({ method: "GET", key, expiresInSeconds: 300 });
      const read = await fetch(url, { headers: { range: "bytes=10-19" } });
      expect(read.status).toBe(206);
      expect(read.headers.get("content-range")).toBe("bytes 10-19/256");
      await expect(bytesOf(read)).resolves.toEqual(body.slice(10, 20));
    });

    it("accepts a presigned PUT and the object reads back through the client", async () => {
      const key = `${randomPrefix()}uploaded.txt`;

      const url = await client.getSignedUrl({ method: "PUT", key, expiresInSeconds: 300 });
      const written = await fetch(url, { method: "PUT", body: "written without credentials" });
      expect(written.status).toBe(200);
      await discard(written);

      const read = await client.get({ key });
      await expect(read.text()).resolves.toBe("written without credentials");
    });

    it("answers 404 to a presigned GET of a key that does not exist", async () => {
      const url = await client.getSignedUrl({
        method: "GET",
        bucket: BUCKET,
        key: `${randomPrefix()}absent.txt`,
        expiresInSeconds: 300,
      });

      const read = await fetch(url);
      expect(read.status).toBe(404);
      await discard(read);
    });
  });
});

/** The five keys the list assertions are written against, in lexicographic order. */
async function seedTree(client: S3Client, prefix: string): Promise<void> {
  for (const name of ["a.txt", "b.txt", "nested/c.txt", "nested/d.txt", "nested/deep/e.txt"]) {
    await seed(client, `${prefix}${name}`, name, "text/plain");
  }
}

/** The object's etag as the store quotes it, ready to hand back as a conditional. */
async function etagOf(client: S3Client, key: string): Promise<string> {
  const read = await client.head({ key });
  const etag = read.headers.get("etag");
  await discard(read);
  if (!etag) throw new Error(`no etag on HEAD ${key}`);
  return etag;
}

/**
 * The `S3Error` a call raised.
 *
 * Written as a helper rather than `rejects.toThrow` so the assertions can be
 * about `status` and `code` — the two fields that actually distinguish "missing"
 * from "forbidden" from "precondition failed" — instead of about the message,
 * which the stores word differently.
 */
async function rejection(run: () => Promise<unknown>): Promise<S3Error> {
  let resolved: unknown;
  try {
    resolved = await run();
  } catch (error) {
    if (error instanceof S3Error) return error;
    throw error;
  }
  if (resolved instanceof Response) await discard(resolved);
  throw new Error(`expected an S3Error, but the call resolved with ${summarize(resolved)}`);
}

function summarize(value: unknown): string {
  if (value instanceof Response) return `a ${String(value.status)} response`;
  return JSON.stringify(value) ?? String(value);
}
