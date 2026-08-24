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
   * A `ReadableStream` body used to be unsendable: `new Request(url, { body })`
   * throws `duplex option is required` on undici, Deno, Bun and workerd unless
   * `duplex: "half"` is passed with it, so the request never reached the socket
   * at all. These two put real bytes through a real store in several chunks and
   * compare what comes back, which is the only way to find out that the halves
   * arrived in one piece and in order.
   */
  describe("streaming bodies", () => {
    it("uploads a streamed body and reads it back byte for byte", async () => {
      const key = `${randomPrefix()}streamed.bin`;
      const body = countingBytes(3 * 1024);

      const written = await client.put({
        key,
        body: streamOf(body, 1024),
        contentType: "application/octet-stream",
        /*
         * Declared rather than chunked, because that is what works everywhere:
         * a stream with no length goes out as `Transfer-Encoding: chunked`, and
         * RustFS — like AWS — will not take a PUT without a `Content-Length`.
         * The two tests below assert that difference; this one is about the
         * bytes, and asserts them on both stores.
         */
        headers: { "content-length": String(body.byteLength) },
      });
      expect(written.status).toBe(200);
      await discard(written);

      const read = await client.get({ key });
      expect(read.status).toBe(200);
      await expect(bytesOf(read)).resolves.toEqual(body);
    });

    it.skipIf(!spec.chunkedUploads)("uploads a streamed body of unknown length", async () => {
      const key = `${randomPrefix()}chunked.bin`;
      const body = countingBytes(3 * 1024);

      await discard(
        await client.put({
          key,
          body: streamOf(body, 1024),
          contentType: "application/octet-stream",
        }),
      );

      const read = await client.get({ key });
      await expect(bytesOf(read)).resolves.toEqual(body);
    });

    it.skipIf(spec.chunkedUploads)("answers 411 to a body of unknown length", async () => {
      const key = `${randomPrefix()}chunked.bin`;

      const refused = await rejection(() =>
        client.put({
          key,
          body: streamOf(countingBytes(3 * 1024), 1024),
          contentType: "application/octet-stream",
        }),
      );
      /* The store's rule, not the client's: it wants a length and says so. */
      expect(refused.status).toBe(411);
      expect(refused.code).toBe("MissingContentLength");
    });

    it("uploads a streamed multipart part", async () => {
      const key = `${randomPrefix()}streamed-part.bin`;
      const first = countingBytes(MIN_PART_BYTES);
      const second = countingBytes(TAIL_PART_BYTES, MIN_PART_BYTES);

      const { uploadId } = await client.initiateMultipart({ key });
      const partOne = await client.uploadPart({
        key,
        uploadId,
        partNumber: 1,
        body: streamOf(first, 64 * 1024),
        contentLength: first.byteLength,
      });
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

      const read = await client.get({ key });
      expect(read.headers.get("content-length")).toBe(String(first.length + second.length));
      await expect(bytesOf(read).then(sha256Hex)).resolves.toBe(
        await sha256Hex(joined(first, second)),
      );
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
       * An equality, and it took a fix to earn. SeaweedFS XML-escapes the quotes
       * around `<ETag>` as the NUMERIC entity `&#34;`, which `decodeXml` did not
       * know: the entity survived parsing, `stripQuotes` never saw a leading
       * quote, and a listed etag read `&#34;5eb6…&#34;` where the HEAD said
       * `5eb6…`. RustFS sends the hex bare and always came back clean, which is
       * exactly why one store is not enough. The listed etag is now the object's
       * etag, on both.
       */
      const etag = (await etagOf(client, `${prefix}sized.txt`)).replaceAll('"', "");
      expect(entry?.etag).toBe(etag);
    });

    /*
     * Keys that make the store escape its own XML, listed through a paginated
     * walk so the continuation token is exercised on the same documents. The
     * last of them is the one that matters most: a key whose text IS the four
     * characters `&lt;` gets escaped by the store as `&amp;lt;`, and a decoder
     * that resolved `&amp;` first and then went on reading its own output handed
     * back `<`. The key as reported could not be asked for.
     */
    it("round-trips keys that have to be escaped, across pages", async () => {
      const prefix = randomPrefix();
      const names = [`a&b.txt`, `c<d>.txt`, `e"f.txt`, `g'h.txt`, `i&lt;j.txt`];
      for (const name of names) await seed(client, `${prefix}${name}`, name, "text/plain");

      const seen: string[] = [];
      let token: string | undefined;
      let pages = 0;
      do {
        const page = await client.list({ prefix, maxKeys: 2, continuationToken: token });
        seen.push(...page.contents.map((entry) => entry.key));
        token = page.isTruncated ? page.nextContinuationToken : undefined;
        pages += 1;
      } while (token && pages < 10);

      expect(pages).toBeGreaterThan(1);
      expect(seen).toEqual([...names].sort().map((name) => `${prefix}${name}`));

      /* And every key it reported is a key it can fetch back. */
      for (const key of seen) {
        const read = await client.get({ key });
        expect(read.status).toBe(200);
        await expect(read.text()).resolves.toBe(key.slice(prefix.length));
      }
    });

    /*
     * A newline is a legal byte in an S3 key and an awkward one everywhere else:
     * it travels as `%0A`, comes back inside the XML as a raw line break, and a
     * parser that reads a line at a time loses it. SeaweedFS stores it; RustFS
     * refuses keys with control characters outright, so that refusal is what is
     * asserted there rather than nothing at all.
     */
    it.skipIf(!spec.controlCharsInKeys)("round-trips a key containing a newline", async () => {
      const prefix = randomPrefix();
      const key = `${prefix}two\nlines.txt`;

      await seed(client, key, "hello world", "text/plain");

      const listed = await client.list({ prefix });
      expect(listed.contents.map((entry) => entry.key)).toEqual([key]);

      const read = await client.get({ key });
      await expect(read.text()).resolves.toBe("hello world");
    });

    it.skipIf(spec.controlCharsInKeys)("is told off for a key containing a newline", async () => {
      const key = `${randomPrefix()}two\nlines.txt`;

      const refused = await rejection(() => client.put({ key, body: "hello world" }));
      expect(refused.status).toBe(400);
      expect(refused.code).toBe("InvalidArgument");
    });

    /*
     * A space in a prefix is where the signed query and the sent query used to
     * part company: SigV4 canonicalises it as `%20`, `URLSearchParams` sent `+`.
     * Both stores here are lenient enough to answer either — AWS is not, which
     * is why the byte-level assertion lives in `test/client-wire.test.ts` — so
     * what this proves is the other half: the new encoding is one real stores
     * understand, and the keys come back.
     */
    it("lists a prefix with a space in it", async () => {
      const prefix = `${randomPrefix()}my folder/`;
      await seed(client, `${prefix}a.txt`, "a", "text/plain");
      await seed(client, `${prefix}nested/b.txt`, "b", "text/plain");

      const listed = await client.list({ prefix });
      expect(listed.contents.map((entry) => entry.key)).toEqual([
        `${prefix}a.txt`,
        `${prefix}nested/b.txt`,
      ]);

      const rolled = await client.list({ prefix, delimiter: "/" });
      expect(rolled.contents.map((entry) => entry.key)).toEqual([`${prefix}a.txt`]);
      expect(rolled.commonPrefixes).toEqual([`${prefix}nested/`]);
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

    /*
     * `applyChecksum` used to run only inside `execute`, and `uploadPart` calls
     * the transport directly — so a client told `requireOnPut` uploaded every
     * part unchecked and reported success. Here the checksum is computed by this
     * client and validated by a real store: a wrong digest, a wrong encoding or
     * a header excluded from the signature all fail this, and only agreement
     * passes it.
     */
    it("checksums every part of an upload when asked to", async () => {
      const checked = clientFor(spec, store, {
        checksum: { algorithm: "sha256", requireOnPut: true },
      });
      const key = `${randomPrefix()}checksummed.bin`;
      const first = countingBytes(MIN_PART_BYTES);
      const second = countingBytes(TAIL_PART_BYTES, MIN_PART_BYTES);
      const whole = new Uint8Array(first.length + second.length);
      whole.set(first, 0);
      whole.set(second, first.length);

      const { uploadId } = await checked.initiateMultipart({
        key,
        contentType: "application/octet-stream",
      });
      const partOne = await checked.uploadPart({ key, uploadId, partNumber: 1, body: first });
      const partTwo = await checked.uploadPart({ key, uploadId, partNumber: 2, body: second });
      await discard(
        await checked.completeMultipart({
          key,
          uploadId,
          parts: [
            { partNumber: 1, etag: partOne.etag },
            { partNumber: 2, etag: partTwo.etag },
          ],
        }),
      );

      const read = await checked.get({ key });
      await expect(bytesOf(read).then(sha256Hex)).resolves.toBe(await sha256Hex(whole));
    });

    it("refuses to upload a streamed part it was told to checksum", async () => {
      const checked = clientFor(spec, store, {
        checksum: { algorithm: "sha256", requireOnPut: true },
      });
      const key = `${randomPrefix()}unchecksummable.bin`;

      const { uploadId } = await checked.initiateMultipart({ key });
      await expect(
        checked.uploadPart({
          key,
          uploadId,
          partNumber: 1,
          body: streamOf(countingBytes(1024), 256),
        }),
      ).rejects.toThrow(/Unable to compute sha256 checksum/i);

      /* Refused before sending, so the upload is still empty and still abortable. */
      await expect(checked.abortMultipart({ key, uploadId })).resolves.toBeUndefined();
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

  /*
   * The tenant-escape, against a real store.
   *
   * `users/a/../b/x` is a legal S3 key and an illegal URL path: every WHATWG
   * parser removes the dot segment, so the request that used to leave here asked
   * for `users/b/x` — a write outside the prefix it was scoped to, reported as a
   * success under the name it never used. The client now refuses, and what this
   * asserts is the consequence: after the refusal there is nothing at the
   * escaped location, on either store.
   */
  describe("keys with dot segments", () => {
    it("writes nothing rather than writing somewhere else", async () => {
      const prefix = randomPrefix();

      await expect(
        client.put({ key: `${prefix}dir/../evil.txt`, body: "escaped", contentType: "text/plain" }),
      ).rejects.toThrow(/dot segment/i);

      const listed = await client.list({ prefix });
      expect(listed.contents).toEqual([]);

      const missing = await rejection(() => client.get({ key: `${prefix}evil.txt` }));
      expect(missing.status).toBe(404);
    });

    it("keeps dots that are part of a name", async () => {
      const key = `${randomPrefix()}archive..tar.gz`;

      await seed(client, key, "not a dot segment", "application/gzip");

      const read = await client.get({ key });
      await expect(read.text()).resolves.toBe("not a dot segment");
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

    /*
     * The query of a presigned URL is not decoration: the store re-derives the
     * canonical request from it and compares signatures. A space encoded as `+`
     * on the wire and as `%20` in the signature is therefore a URL that fails
     * its own signature, and this is the test that would have caught it — the
     * value is one the store has no opinion about, so all it can be judging is
     * the encoding.
     */
    it("serves a presigned GET whose key and query both contain spaces", async () => {
      const key = `${randomPrefix()}my shared file.txt`;
      await seed(client, key, "hello world", "text/plain");

      const url = await client.getSignedUrl({
        method: "GET",
        key,
        query: { "x-uns3-note": "a spaced value" },
        expiresInSeconds: 300,
      });
      expect(url).toContain("my%20shared%20file.txt");
      expect(url.slice(url.indexOf("?"))).not.toContain("+");

      const read = await fetch(url);
      expect(read.status).toBe(200);
      await expect(read.text()).resolves.toBe("hello world");
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

/**
 * `bytes` as a stream, handed over in `chunkSize` pieces.
 *
 * Several chunks rather than one on purpose: a single-chunk stream is a buffer
 * wearing a costume, and would pass even if the transfer were being collected
 * and re-sent whole somewhere along the way.
 */
function streamOf(bytes: Uint8Array<ArrayBuffer>, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

/** Two parts as the one object they assemble into. */
function joined(first: Uint8Array, second: Uint8Array): Uint8Array<ArrayBuffer> {
  const whole = new Uint8Array(first.length + second.length);
  whole.set(first, 0);
  whole.set(second, first.length);
  return whole;
}

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
