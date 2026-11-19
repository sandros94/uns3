/*
 * The part of the integration suite that is about stores rather than about S3:
 * which images stand in for a real store, how each one signals that it is
 * actually serving, how a bucket comes to exist inside it, and how an existing
 * store is reached instead. The battery itself lives next door, is written
 * exactly once, and is handed one of these.
 *
 * TWO STORES RATHER THAN ONE, deliberately. A single implementation's quirks
 * read as "the protocol" until a second implementation disagrees with them;
 * where these two agree, the client is speaking S3 rather than speaking
 * SeaweedFS. Where they disagree, the suite says so per store instead of
 * softening the assertion until both fit under it.
 *
 * AN EXTERNAL STORE ON DEMAND. Setting `UNS3_TEST_ENDPOINT` points the same
 * battery at a store that already runs (AWS, R2, any provider), in place of the
 * containers. Neither container validates what a strict provider does — the
 * SeaweedFS gateway runs without identities and accepts any signature — so this
 * is the leg that holds the client to a production store.
 */

import { GenericContainer, Wait, getContainerRuntimeClient } from "testcontainers";
import type { StartedTestContainer, WaitStrategy } from "testcontainers";
import { signRequest } from "../../src/core.ts";
import { S3Client } from "../../src/index.ts";
import type { BucketStyle, Credentials, PutObjectParams, S3ClientConfig } from "../../src/index.ts";

/** Signing region of the containers. Neither cares which it is; both care that it is stable. */
export const REGION: string = "us-east-1";

/** The bucket every container leg uses. Containers are per-leg, so it is fresh each time. */
export const BUCKET: string = "uns3-integration";

/** Pulling and booting a store is minutes, not milliseconds. */
export const STARTUP_TIMEOUT_MS: number = 180_000;

/** How long a store gets to become willing to create a bucket after it boots. */
export const BUCKET_TIMEOUT_MS: number = 120_000;

/** How long one warm-up write may take before it is abandoned and tried again. */
const WARMUP_WRITE_TIMEOUT_MS = 10_000;

/** How many warm-up writes a store gets before the leg fails. */
const WARMUP_ATTEMPTS = 12;

const POLL_MS = 500;

/**
 * The key root everything in this run writes under.
 *
 * Irrelevant to a container, which is thrown away with what it holds. An
 * external bucket outlives the run, so its leg deletes this root when it ends,
 * and nothing outside it is ever touched.
 */
const RUN_ROOT = `uns3-it/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}/`;

/** Names accepted in `UNS3_TEST_STORES`. */
export type StoreName = "seaweedfs" | "rustfs";

/** How a store treats the requests the stores were found to disagree on. */
export interface StoreBehaviour {
  /**
   * Whether the store accepts a body of unknown length.
   *
   * A `ReadableStream` with no `Content-Length` goes out as
   * `Transfer-Encoding: chunked`. SeaweedFS reads it; RustFS answers `411
   * MissingContentLength` and is in good company doing so — AWS S3 requires a
   * length on PUT too. Declaring one (`contentLength` on a put or on a part, or
   * the header by hand) satisfies every store, which is what the
   * length-declaring tests assert; this flag only decides which side of the
   * disagreement the unknown-length tests assert.
   */
  chunkedUploads: boolean;
  /**
   * Whether a key may contain control characters.
   *
   * A newline is a legal S3 key byte and SeaweedFS stores one happily. RustFS
   * rejects it with `400 InvalidArgument` before looking at anything else, so
   * the round-trip is asserted on one store and the refusal on the other rather
   * than dropping the case that proves the client transmits it faithfully.
   */
  controlCharsInKeys: boolean;
}

/** A store the suite starts in a container. Everything that differs between them, and nothing that does not. */
export interface ContainerStoreSpec extends StoreBehaviour {
  kind: "container";
  /** The name in `UNS3_TEST_STORES`, and the name the suite reports under. */
  name: StoreName;
  /** Pinned by digest-free tag on purpose: these are the tags the maintainer reads. */
  image: string;
  /** Port the S3 API listens on *inside* the container. */
  port: number;
  /** Overrides the image's own command when the image needs telling what to be. */
  command?: string[];
  /** Environment the image reads its root credentials (or anything else) from. */
  env?: Record<string, string>;
  /**
   * Built fresh on every start rather than shared: a wait strategy is handed the
   * container it is watching, so a single instance reused across two legs is a
   * strategy holding a reference to a container that has already been stopped.
   */
  wait: () => WaitStrategy;
  /** What the client signs with, and what the store was told to accept. */
  credentials: Credentials;
  /**
   * Whether the set-up requests have to carry a signature.
   *
   * This is not a preference, it is what the store will answer. SeaweedFS's S3
   * gateway runs without an identity file here and so authorises everything,
   * signed or not; RustFS validates SigV4 on every request including these, and
   * answers a bare PUT with 403. The bucket has to exist before an `S3Client`
   * has anything to talk to, so the suite signs these by hand.
   */
  signSetup: boolean;
}

/** A store that already runs, with a bucket that already exists. */
export interface ExternalStoreSpec extends StoreBehaviour {
  kind: "external";
  name: "external";
  endpoint: string;
  bucket: string;
  region: string;
  credentials: Credentials;
  /** Left to the client's own default when unset, which is what production gets. */
  bucketStyle?: BucketStyle;
}

export type StoreSpec = ContainerStoreSpec | ExternalStoreSpec;

export const STORES: Record<StoreName, ContainerStoreSpec> = {
  seaweedfs: {
    kind: "container",
    name: "seaweedfs",
    image: "chrislusf/seaweedfs:4.54",
    port: 8333,
    command: ["server", "-s3"],
    /*
     * The S3 gateway starts well after the port it will eventually listen on is
     * bound — a port wait returns while the gateway is still coming up, and the
     * first bucket-create then lands on a listener that is not serving yet. This
     * line is the readiness signal; the port is not.
     */
    wait: () => Wait.forLogMessage(/Start Seaweed S3 API Server/),
    credentials: { accessKeyId: "uns3", secretAccessKey: "uns3-secret" },
    chunkedUploads: true,
    controlCharsInKeys: true,
    signSetup: false,
  },
  rustfs: {
    kind: "container",
    name: "rustfs",
    image: "rustfs/rustfs:1.0.6",
    port: 9000,
    /*
     * The image's entrypoint resolves its root credential pair from exactly these
     * two names (falling back to the well-known `rustfsadmin`/`rustfsadmin` and
     * warning about it). Set explicitly so the suite's credentials and the
     * store's are one decision rather than two that happen to agree.
     */
    env: { RUSTFS_ACCESS_KEY: "rustfsadmin", RUSTFS_SECRET_KEY: "rustfsadmin" },
    /*
     * RustFS logs at `warn` by default and so says nothing at all on a clean
     * start — there is no line to wait for. `/health` is unauthenticated and
     * answers 200 only once the S3 API is up, which makes it the readiness
     * signal the logs do not provide.
     */
    wait: () => Wait.forHttp("/health", 9000),
    credentials: { accessKeyId: "rustfsadmin", secretAccessKey: "rustfsadmin" },
    chunkedUploads: false,
    controlCharsInKeys: false,
    signSetup: true,
  },
};

/** Every valid `UNS3_TEST_STORES` name, in the order they run by default. */
export const STORE_NAMES: StoreName[] = Object.keys(STORES) as StoreName[];

/**
 * Whether there is a container runtime to start a store in.
 *
 * Probed once, at import, through testcontainers' own client rather than by
 * shelling out to `docker`: it is the very discovery the containers will use, so
 * a `true` here means the socket they need is really reachable — including the
 * rootless, Podman and Colima layouts that a bare `docker version` misses, and
 * excluding a `docker` binary on `PATH` that has nothing behind it.
 */
export const HAS_CONTAINER_RUNTIME: boolean = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

/** A store that is serving, and where the test process reaches it. */
export interface StartedStore {
  /** Host-side endpoint, on whatever port the runtime happened to publish. */
  endpoint: string;
  bucket: string;
  region: string;
  bucketStyle: BucketStyle | undefined;
  /** Releases what the leg holds: the container, or the keys written to an external bucket. */
  stop: () => Promise<void>;
}

/**
 * The store legs to run.
 *
 * `UNS3_TEST_ENDPOINT` selects the external store and nothing else. Otherwise
 * `UNS3_TEST_STORES` picks containers, defaulting to all of them. An unknown
 * name, or both variables at once, is a mistake worth failing on rather than a
 * selection to guess at — a suite that runs zero legs, or not the legs that
 * were asked for, and reports success is the worst possible answer here.
 */
export function selectedStores(): StoreSpec[] {
  const raw = process.env.UNS3_TEST_STORES?.trim();

  if (process.env.UNS3_TEST_ENDPOINT) {
    if (raw) {
      throw new Error(
        "UNS3_TEST_ENDPOINT and UNS3_TEST_STORES are both set; an external store replaces the containers, so set only one.",
      );
    }
    return [externalStore()];
  }

  if (!raw) return STORE_NAMES.map((name) => STORES[name]);

  const requested = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (requested.length === 0) return STORE_NAMES.map((name) => STORES[name]);

  return requested.map((name) => {
    const spec = STORES[name as StoreName];
    if (!spec) {
      throw new Error(
        `Unknown store "${name}" in UNS3_TEST_STORES; valid names are: ${STORE_NAMES.join(", ")}.`,
      );
    }
    return spec;
  });
}

/**
 * The external store described by the `UNS3_TEST_*` variables.
 *
 * It is held to what AWS S3 does on the two points the containers disagree on:
 * a length is required on PUT, and a newline is a legal key byte. A provider
 * that differs fails those tests, which is the report this leg exists to give.
 */
function externalStore(): ExternalStoreSpec {
  const endpoint = requiredEnv("UNS3_TEST_ENDPOINT");
  const bucket = requiredEnv("UNS3_TEST_BUCKET");
  const accessKeyId = requiredEnv("UNS3_TEST_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv("UNS3_TEST_SECRET_ACCESS_KEY");
  const sessionToken = process.env.UNS3_TEST_SESSION_TOKEN || undefined;

  const bucketStyle = process.env.UNS3_TEST_BUCKET_STYLE || undefined;
  if (bucketStyle !== undefined && bucketStyle !== "path" && bucketStyle !== "virtual") {
    throw new Error(`UNS3_TEST_BUCKET_STYLE must be "path" or "virtual", not "${bucketStyle}".`);
  }

  return {
    kind: "external",
    name: "external",
    endpoint,
    bucket,
    region: process.env.UNS3_TEST_REGION || REGION,
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
    bucketStyle,
    chunkedUploads: false,
    controlCharsInKeys: true,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when UNS3_TEST_ENDPOINT is set.`);
  return value;
}

/** Whether this run can reach every selected store. */
export function canRun(stores: StoreSpec[]): boolean {
  return HAS_CONTAINER_RUNTIME || stores.every((spec) => spec.kind === "external");
}

/** Gets a store serving: starts and readies a container, or takes the external one as it is. */
export async function startStore(spec: StoreSpec): Promise<StartedStore> {
  if (spec.kind === "external") {
    const store: StartedStore = {
      endpoint: spec.endpoint,
      bucket: spec.bucket,
      region: spec.region,
      bucketStyle: spec.bucketStyle,
      stop: () => purgeRunRoot(clientFor(spec, store)),
    };
    return store;
  }

  let builder = new GenericContainer(spec.image)
    .withExposedPorts(spec.port)
    .withWaitStrategy(spec.wait())
    .withStartupTimeout(STARTUP_TIMEOUT_MS);

  if (spec.command) builder = builder.withCommand(spec.command);
  if (spec.env) builder = builder.withEnvironment(spec.env);

  const container: StartedTestContainer = await builder.start();
  const endpoint = `http://${container.getHost()}:${String(container.getMappedPort(spec.port))}`;

  try {
    await createBucket(spec, endpoint);
    await awaitFirstWrite(spec, endpoint);
  } catch (error) {
    await container.stop();
    throw error;
  }

  return {
    endpoint,
    bucket: BUCKET,
    region: REGION,
    bucketStyle: "path",
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * Creates {@link BUCKET}, retrying until the store agrees to.
 *
 * The retry is not belt-and-braces: SeaweedFS answers on its S3 port before it
 * is willing to serve bucket operations on it, so the first attempt can be
 * refused by a store that is, a moment later, perfectly healthy.
 */
export async function createBucket(spec: ContainerStoreSpec, endpoint: string): Promise<void> {
  const url = new URL(`${endpoint}/${BUCKET}`);
  const giveUp = Date.now() + BUCKET_TIMEOUT_MS;
  let last = "no attempt was made";

  for (;;) {
    try {
      const response = await setupRequest(spec, "PUT", url);
      /* 409 is `BucketAlreadyOwnedByYou`, which is this function's goal already met. */
      if (response.ok || response.status === 409) {
        await discard(response);
        return;
      }
      last = `answered ${String(response.status)}: ${(await response.text()).slice(0, 200)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }

    if (Date.now() >= giveUp) {
      throw new Error(`could not create bucket "${BUCKET}" at ${endpoint}; last: ${last}`);
    }
    await delay(POLL_MS);
  }
}

/**
 * Writes and deletes one object, retrying until the store takes the write.
 *
 * A bucket that exists can still hold its first object write for seconds while
 * the store lays out space for it (newer SeaweedFS releases take about five on
 * a fresh container). That is start-up cost, not conformance, and the first test
 * to write must not be the one to pay it.
 */
async function awaitFirstWrite(spec: ContainerStoreSpec, endpoint: string): Promise<void> {
  const url = new URL(`${endpoint}/${BUCKET}/.ready-${crypto.randomUUID()}`);
  let last = "no attempt was made";

  for (let attempt = 0; attempt < WARMUP_ATTEMPTS; attempt += 1) {
    try {
      const written = await setupRequest(
        spec,
        "PUT",
        url,
        "ready",
        AbortSignal.timeout(WARMUP_WRITE_TIMEOUT_MS),
      );
      if (written.ok) {
        await discard(written);
        await discard(await setupRequest(spec, "DELETE", url));
        return;
      }
      last = `answered ${String(written.status)}: ${(await written.text()).slice(0, 200)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(POLL_MS);
  }

  throw new Error(`bucket "${BUCKET}" at ${endpoint} never accepted a first write; last: ${last}`);
}

/**
 * One set-up request, signed when the store insists on it.
 *
 * Signed per call rather than once per loop: a SigV4 signature commits to the
 * minute it was made in, and the set-up loops are allowed to run for two of
 * them — a signature hoisted out would start being rejected for skew partway
 * through, turning "the store was slow" into "the credentials are wrong".
 */
async function setupRequest(
  spec: ContainerStoreSpec,
  method: "PUT" | "DELETE",
  url: URL,
  body?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = spec.signSetup
    ? (
        await signRequest({
          method,
          url,
          region: REGION,
          credentials: spec.credentials,
          headers: new Headers(),
          body: body ?? null,
        })
      ).headers
    : new Headers();

  return fetch(url, { method, headers, body, signal });
}

/**
 * Deletes everything this run wrote under {@link RUN_ROOT}.
 *
 * Best effort by design: a key that will not delete is reported and skipped, so
 * one stuck object does not hide the rest of the leg's results behind a failed
 * teardown.
 */
async function purgeRunRoot(client: S3Client): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const page = await client.list({ prefix: RUN_ROOT, continuationToken });
    for (const { key } of page.contents) {
      try {
        await discard(await client.del({ key }));
      } catch (error) {
        console.warn(`[uns3] could not delete ${key}:`, error);
      }
    }
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (continuationToken);
}

/**
 * The client the whole battery runs through.
 *
 * Containers are addressed path style, and that is not a preference either:
 * both answer on an address with no wildcard DNS in front of it, so a
 * virtual-hosted request would be sent to a hostname that does not resolve.
 *
 * `overrides` is for the handful of tests that need a differently configured
 * client — checksums, say — against the same running store.
 */
export function clientFor(
  spec: StoreSpec,
  store: StartedStore,
  overrides: Partial<S3ClientConfig> = {},
): S3Client {
  return new S3Client({
    endpoint: store.endpoint,
    region: store.region,
    credentials: spec.credentials,
    ...(store.bucketStyle ? { bucketStyle: store.bucketStyle } : {}),
    defaultBucket: store.bucket,
    ...overrides,
  });
}

/**
 * A key prefix no other test will write under.
 *
 * Every test claims one. The isolation is what lets a test list a prefix and
 * assert on *everything* under it rather than on a subset — the assertions in
 * the list tests are exact because of this. All of them sit under
 * {@link RUN_ROOT}, which is what an external leg cleans up.
 */
export function randomPrefix(): string {
  return `${RUN_ROOT}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}/`;
}

/** Writes an object and drops the response, for the arrange half of a test. */
export async function seed(
  client: S3Client,
  key: string,
  body: PutObjectParams["body"],
  contentType?: string | false,
): Promise<void> {
  await discard(await client.put({ key, body, contentType }));
}

/** A response's body as bytes, which is the only representation binary data survives. */
export async function bytesOf(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Releases a response body the test does not read. Undici holds the connection
 * open until the body is consumed or cancelled, and a suite that leaks one per
 * PUT eventually stops making progress rather than failing.
 */
export async function discard(response: Response): Promise<void> {
  await response.body?.cancel();
}

/**
 * Hex SHA-256 of some bytes, used to compare multi-megabyte bodies.
 *
 * A byte-for-byte `toEqual` on five megabytes is exact but ruinous when it
 * fails: the reporter renders the diff. A digest is just as exact and fails in
 * one line.
 */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Bytes `0..255` repeating, so any slice of them identifies its own offset. */
export function countingBytes(length: number, offset: number = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index + offset) & 0xff;
  return bytes;
}

function delay(ms: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, ms));
}
