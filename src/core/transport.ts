import type { TransportOptions, TransportResult } from "../types";

/**
 * Dispatches the request via the configured fetch implementation.
 *
 * @param options - Request and AbortSignal wrapper.
 * @param fetcher - Fetch-compatible implementation to invoke.
 */
export async function send(
  { request, signal }: TransportOptions,
  fetcher: typeof fetch,
): Promise<TransportResult> {
  const response = await fetcher(request, { signal });
  return { response };
}
