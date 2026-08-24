/*
 * The XML that comes back from a list, and what the hand-rolled parser makes of
 * it.
 *
 * The parser is regex-based on purpose — a DOM parser is not available in every
 * runtime this client targets and a bundled one would be the dependency the
 * package does not have. That choice is fine; what was not fine is how narrow
 * the reading was. Every document below is one a real store has sent or is
 * plainly entitled to send, fed through `list()` with a `fetch` mock so the
 * assertions are about parsing and nothing else.
 */

import { describe, expect, it } from "vitest";

import { type Credentials, S3Client } from "../src/index.ts";
import type { ListObjectsV2Response } from "../src/index.ts";

const credentials: Credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

/*
 * ENTITIES.
 *
 * The old decoder ran five sequential `replace` passes and knew five names. It
 * missed every numeric character reference — including `&#34;`, which is how
 * SeaweedFS escapes the quotes around an ETag, so a listed etag read
 * `&#34;5eb6…&#34;` and never matched the one a HEAD reported. And because
 * `&amp;` was decoded FIRST, its output was fed to the passes after it: a
 * document containing `&amp;lt;` — the escaping of the literal text `&lt;` —
 * came out as `<`. One pass, `&amp;` resolved like any other name and never
 * re-read, is both the fix and the simpler shape.
 */
describe("entity decoding", () => {
  it("decodes decimal character references", async () => {
    const listed = await listing(contents({ key: "quoted.txt", etag: "&#34;abc123&#34;" }));
    expect(listed.contents[0]?.etag).toBe("abc123");
  });

  it("decodes hex character references in either case", async () => {
    const lower = await listing(contents({ key: "a&#x2F;b.txt" }));
    expect(lower.contents[0]?.key).toBe("a/b.txt");

    const upper = await listing(contents({ key: "a&#X2F;b.txt" }));
    expect(upper.contents[0]?.key).toBe("a/b.txt");

    const quoted = await listing(contents({ key: "q.txt", etag: "&#x22;abc123&#x22;" }));
    expect(quoted.contents[0]?.etag).toBe("abc123");
  });

  it("decodes the named entities XML actually defines", async () => {
    const listed = await listing(contents({ key: "&lt;a&gt;&amp;&quot;&apos;.txt" }));
    expect(listed.contents[0]?.key).toBe(`<a>&"'.txt`);
  });

  it("decodes &amp; last, so an escaped entity stays escaped", async () => {
    /* `&amp;lt;` is the escaping of the four characters `&lt;`. Decoding it to
       `<` is decoding twice, and a key that reads `&lt;` is then unopenable. */
    const listed = await listing(contents({ key: "&amp;lt;not-a-tag.txt" }));
    expect(listed.contents[0]?.key).toBe("&lt;not-a-tag.txt");

    const doubled = await listing(contents({ key: "&amp;amp;.txt" }));
    expect(doubled.contents[0]?.key).toBe("&amp;.txt");
  });

  it("decodes code points above ASCII, astral ones included", async () => {
    const accented = await listing(contents({ key: "caf&#233;.txt" }));
    expect(accented.contents[0]?.key).toBe("café.txt");

    const astral = await listing(contents({ key: "&#128512;.txt" }));
    expect(astral.contents[0]?.key).toBe("😀.txt");

    /* The same character written as the surrogate pair some encoders emit. */
    const surrogates = await listing(contents({ key: "&#55357;&#56832;.txt" }));
    expect(surrogates.contents[0]?.key).toBe("😀.txt");

    const hexAstral = await listing(contents({ key: "&#x1F600;.txt" }));
    expect(hexAstral.contents[0]?.key).toBe("😀.txt");
  });

  it("leaves alone what it does not recognise", async () => {
    /* Not an entity this decoder knows, and not its place to guess. */
    const unknown = await listing(contents({ key: "a&nbsp;b.txt" }));
    expect(unknown.contents[0]?.key).toBe("a&nbsp;b.txt");

    /* Out of Unicode range: a decoder that trusted it would throw mid-listing. */
    const overflow = await listing(contents({ key: "a&#1114112;b.txt" }));
    expect(overflow.contents[0]?.key).toBe("a&#1114112;b.txt");
  });

  it("decodes the entities in an error message too", async () => {
    const client = clientAnswering(
      () =>
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The key &quot;a&#39;b&quot; does not exist</Message></Error>`,
          { status: 404 },
        ),
    );

    await expect(client.get({ bucket: "my-bucket", key: "a.txt" })).rejects.toMatchObject({
      message: `The key "a'b" does not exist`,
    });
  });
});

/*
 * SHAPE.
 *
 * The element patterns demanded a bare `<Key>`, which is only the most common
 * spelling of it. A store is free to put a namespace declaration or any other
 * attribute on any element, and free to wrap text in CDATA rather than escaping
 * it — both are ordinary XML, and both used to make an entry vanish from the
 * result with no error anywhere.
 */
describe("document shape", () => {
  it("reads elements that carry attributes", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>false</IsTruncated>
  <Contents xmlns:x="urn:x">
    <Key x:type="string">attributed.txt</Key>
    <LastModified>2023-01-01T12:00:00.000Z</LastModified>
    <ETag x:weak="false">&quot;abc123&quot;</ETag>
    <Size unit="bytes">5</Size>
    <StorageClass x:tier="hot">STANDARD</StorageClass>
  </Contents>
  <CommonPrefixes xmlns:x="urn:x">
    <Prefix x:type="string">photos/</Prefix>
  </CommonPrefixes>
</ListBucketResult>`;

    const listed = await listing(xml);
    expect(listed.contents).toEqual([
      {
        key: "attributed.txt",
        size: 5,
        etag: "abc123",
        lastModified: "2023-01-01T12:00:00.000Z",
        storageClass: "STANDARD",
      },
    ]);
    expect(listed.commonPrefixes).toEqual(["photos/"]);
  });

  it("does not mistake a longer element name for the one it wants", async () => {
    /* `<KeyCount>` is not `<Key>`, and tolerating attributes must not blur that. */
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <KeyCount>1</KeyCount>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>real.txt</Key>
    <LastModified>2023-01-01T12:00:00.000Z</LastModified>
    <Size>5</Size>
  </Contents>
</ListBucketResult>`;

    const listed = await listing(xml);
    expect(listed.contents.map((entry) => entry.key)).toEqual(["real.txt"]);
  });

  it("unwraps CDATA rather than reading the wrapper as text", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key><![CDATA[raw & literal <key>.txt]]></Key>
    <LastModified>2023-01-01T12:00:00.000Z</LastModified>
    <Size>7</Size>
  </Contents>
</ListBucketResult>`;

    const listed = await listing(xml);
    /* CDATA content is literal: no entity in there is an entity. */
    expect(listed.contents[0]?.key).toBe("raw & literal <key>.txt");
  });
});

/*
 * PAGING.
 *
 * A ListObjectsV2 answer says where to resume with `<NextContinuationToken>`. A
 * store that only implements V1 — and several S3-compatible ones do, ignoring
 * `list-type=2` entirely — says it with `<NextMarker>` instead, which the parser
 * dropped on the floor: `isTruncated` was true, the token was `undefined`, and a
 * caller looping "while truncated, follow the token" either stopped early or
 * span forever on the same page.
 *
 * The two are surfaced as two fields rather than one because they are not
 * interchangeable: a marker has to go back as `marker`, not as
 * `continuation-token`, and quietly promoting one into the other would send a
 * parameter the store ignores — the infinite loop again, wearing the fix's
 * clothes.
 */
describe("pagination tokens", () => {
  it("reports the continuation token of a truncated V2 listing", async () => {
    const listed = await listing(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>token-2</NextContinuationToken>
</ListBucketResult>`);

    expect(listed.isTruncated).toBe(true);
    expect(listed.nextContinuationToken).toBe("token-2");
    expect(listed.nextMarker).toBeUndefined();
  });

  it("surfaces NextMarker when that is all a truncated listing offers", async () => {
    const listed = await listing(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextMarker>b.txt</NextMarker>
  <Contents>
    <Key>a.txt</Key>
    <LastModified>2023-01-01T12:00:00.000Z</LastModified>
    <Size>1</Size>
  </Contents>
</ListBucketResult>`);

    expect(listed.isTruncated).toBe(true);
    expect(listed.nextMarker).toBe("b.txt");
    /* Not renamed into the V2 field: it is not a V2 token and does not work as one. */
    expect(listed.nextContinuationToken).toBeUndefined();
  });

  it("decodes a token like any other text", async () => {
    const listed = await listing(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>a&amp;b&#x2F;c</NextContinuationToken>
</ListBucketResult>`);

    expect(listed.nextContinuationToken).toBe("a&b/c");
  });
});

/** One `<Contents>` entry, with only the fields a test cares about spelled out. */
function contents(entry: { key: string; etag?: string; size?: number }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>${entry.key}</Key>
    <LastModified>2023-01-01T12:00:00.000Z</LastModified>
    <ETag>${entry.etag ?? "&quot;abc123&quot;"}</ETag>
    <Size>${entry.size ?? 5}</Size>
  </Contents>
</ListBucketResult>`;
}

/** Runs one crafted document through the real `list()` path. */
async function listing(xml: string): Promise<ListObjectsV2Response> {
  const client = clientAnswering(() => new Response(xml, { status: 200 }));
  return await client.list({ bucket: "my-bucket" });
}

function clientAnswering(responder: (request: Request) => Response): S3Client {
  return new S3Client({
    region: "us-east-1",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    credentials,
    retry: { maxAttempts: 1, baseDelayMs: 0 },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return responder(request);
    }) as typeof fetch,
  });
}
