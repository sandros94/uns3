/**
 * The error `S3Client` throws when the store answers with a failure: a status
 * not in `expectedStatus`, an error document inside a `200`, or a document
 * that is not the one requested. A request that never got an answer throws a
 * plain `Error` instead.
 *
 * @example
 * ```ts
 * import { S3Error } from "uns3";
 *
 * try {
 *   await client.get({ key: "missing.txt" });
 * } catch (error) {
 *   if (error instanceof S3Error && error.code === "NoSuchKey") {
 *     // the object does not exist
 *   }
 * }
 * ```
 */
export class S3Error extends Error {
  /** HTTP status of the answer, such as `404`. `200` for an error inside a successful answer. */
  readonly status: number;
  /**
   * S3 error code, such as `"NoSuchKey"` or `"AccessDenied"`. An answer with
   * no error document, such as every `head`, gets the code its status stands
   * for, such as `"NotFound"`.
   */
  readonly code?: string;
  /** Request ID the store assigned, from `x-amz-request-id`. */
  readonly requestId?: string;
  /** Extended request ID, from `x-amz-id-2`. AWS support asks for both. */
  readonly extendedRequestId?: string;
  /** Whether the client would retry this failure by default. */
  readonly retriable: boolean;
  /** Seconds the store asked to wait before retrying, from `Retry-After` or `x-amz-retry-after`. */
  readonly retryAfter?: number;
  /** The bucket or key the error is about, when the store names it. */
  readonly resource?: string;
  /** The region the error document names. */
  readonly region?: string;
  /** The bucket's actual region, from `x-amz-bucket-region`, when a request went to the wrong one. */
  readonly bucketRegion?: string;

  /**
   * @param init - The failure's message, status and S3 details.
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
