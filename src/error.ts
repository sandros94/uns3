/**
 * Structured error raised for non-success responses returned by S3. Captures
 * HTTP status codes alongside S3 specific identifiers for easier debugging.
 */
export class S3Error extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly extendedRequestId?: string;
  readonly retriable: boolean;
  readonly retryAfter?: number;
  readonly resource?: string;
  readonly region?: string;
  readonly bucketRegion?: string;
  readonly cause?: unknown;

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
