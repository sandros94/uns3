export type UppercaseOrLowercase<T extends string> =
  | Uppercase<T>
  | Lowercase<T>;
export type Methods = UppercaseOrLowercase<
  "GET" | "HEAD" | "POST" | "PUT" | "DELETE"
>;

export type Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type CredentialsProvider = () => Promise<Credentials> | Credentials;

export type BucketStyle = "virtual" | "path";

export interface ByteRange {
  start?: number;
  end?: number;
}

export interface ConditionalHeaders {
  ifMatch?: string | string[];
  ifNoneMatch?: string | string[];
  ifModifiedSince?: Date | string;
  ifUnmodifiedSince?: Date | string;
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  jitter?: boolean;
  retriable?: (res: Response | undefined, err: unknown) => boolean;
}

export interface ChecksumConfig {
  algorithm: "none" | "sha256" | "crc32c";
  requireOnPut?: boolean;
}

export interface S3ClientConfig {
  region: string;
  endpoint: string;
  credentials: Credentials | CredentialsProvider;
  defaultBucket?: string;
  bucketStyle?: BucketStyle;
  fetch?: typeof fetch;
  contentTypeResolver?: ContentTypeResolver;
  clockSkewMs?: number;
  retry?: RetryConfig;
  checksum?: ChecksumConfig;
}

export interface BaseRequest {
  bucket?: string;
  key?: string;
  headers?: HeadersInit;
  query?: Record<
    string,
    | string
    | number
    | boolean
    | undefined
    | Array<string | number | boolean | undefined>
  >;
  expectedStatus?: number | number[];
  signal?: AbortSignal;
}

export interface ObjectRequest extends BaseRequest, ConditionalHeaders {
  key: string;
  range?: ByteRange;
}

export type GetObjectParams = ObjectRequest;

export type HeadObjectParams = ObjectRequest;

export interface PutObjectParams extends ObjectRequest {
  body: BodyInit | ReadableStream<Uint8Array> | null;
  contentType?: string | false;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
}

export type DeleteObjectParams = ObjectRequest;

export interface MultipartInitParams extends ObjectRequest {
  contentType?: string | false;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
}

export interface MultipartInitResult {
  uploadId: string;
}

export interface UploadPartParams extends ObjectRequest {
  uploadId: string;
  partNumber: number;
  body: BodyInit | ReadableStream<Uint8Array> | null;
  contentLength?: number;
}

export interface UploadPartResult {
  etag: string;
}

export interface CompleteMultipartParams extends ObjectRequest {
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
}

export interface AbortMultipartParams extends ObjectRequest {
  uploadId: string;
}

export interface ListObjectsV2Params extends BaseRequest {
  prefix?: string;
  delimiter?: string;
  continuationToken?: string;
  maxKeys?: number;
}

export interface ListObjectsV2Response {
  contents: Array<{
    key: string;
    size: number;
    etag: string;
    lastModified: string;
    storageClass?: string;
  }>;
  commonPrefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

export type PresignMethod = "GET" | "PUT" | "HEAD" | "DELETE";

export interface PresignParams extends BaseRequest {
  method: PresignMethod;
  expiresInSeconds?: number;
}

export type ContentTypeResolver = (
  key: string,
  explicit?: string | false,
) => string | undefined;

export interface SignedRequestMetadata {
  authorization: string;
  amzDate: string;
  signedHeaders: string;
}

export interface SigningInit {
  method: string;
  url: URL;
  headers: Headers;
  payloadHash?: string;
}

export interface SignedHeaderResult {
  headers: Headers;
  metadata: SignedRequestMetadata;
}

export interface PresignedUrlResult {
  url: URL;
}

export interface TransportOptions {
  request: Request;
  signal?: AbortSignal;
}

export interface TransportResult {
  response: Response;
}
