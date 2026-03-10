/**
 * Structured error raised for non-success responses returned by S3. Captures
 * HTTP status codes alongside S3 specific identifiers for easier debugging.
 */
export class S3Error extends Error {
  /** HTTP status code from the S3 response (e.g., 404, 403, 500). */
  readonly status: number;
  /** S3 error code string (e.g., `"NoSuchKey"`, `"AccessDenied"`). */
  readonly code?: string;
  /** AWS request ID from the `x-amz-request-id` header. */
  readonly requestId?: string;
  /** Extended request ID from the `x-amz-id-2` header, useful for AWS support cases. */
  readonly extendedRequestId?: string;
  /** Whether this error is considered retriable by the client's retry logic. */
  readonly retriable: boolean;
  /** Seconds to wait before retrying, derived from the `Retry-After` header when present. */
  readonly retryAfter?: number;
  /** The S3 resource (key or bucket) that caused the error, if reported. */
  readonly resource?: string;
  /** The region reported in the error response. */
  readonly region?: string;
  /** The actual region of the bucket, returned by S3 on `AuthorizationHeaderMalformed` or redirect errors. */
  readonly bucketRegion?: string;

  /**
   * @param init - Metadata describing the failure returned by S3.
   */
  constructor(init: {
    message: string;
    status: number;
    code?: string;
    requestId?: string;
    extendedRequestId?: string;
    retriable?: boolean;
    retryAfter?: number;
    resource?: string;
    region?: string;
    bucketRegion?: string;
    cause?: unknown;
  }) {
    super(init.message);
    this.name = "S3Error";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.extendedRequestId = init.extendedRequestId;
    this.retriable = init.retriable ?? false;
    this.retryAfter = init.retryAfter;
    this.resource = init.resource;
    this.region = init.region;
    this.bucketRegion = init.bucketRegion;
    this.cause = init.cause;
  }
}
