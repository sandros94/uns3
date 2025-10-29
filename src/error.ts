/**
 * Structured error raised for non-success responses returned by S3. Captures
 * HTTP status codes alongside S3 specific identifiers for easier debugging.
 */
export class S3Error extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly extendedRequestId?: string;

  /**
   * @param init - Metadata describing the failure returned by S3.
   */
  constructor(init: {
    message: string;
    status: number;
    code?: string;
    requestId?: string;
    extendedRequestId?: string;
  }) {
    super(init.message);
    this.name = "S3Error";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.extendedRequestId = init.extendedRequestId;
  }
}
