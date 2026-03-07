<!-- NOTE: Keep this file updated as the project evolves. When making architectural changes, adding new patterns, or discovering important conventions, update the relevant sections. -->

## Overview

uns3 is a tiny, zero-dependency, runtime-agnostic S3 client that works across Node.js, Deno, Bun, and browsers. It relies entirely on Web Crypto and Fetch APIs (no native dependencies). Compatible with AWS S3 and S3-compatible providers (Cloudflare R2, Hetzner, Backblaze B2, Garage, etc.).

## Commands

- **Install**: `pnpm install` (uses pnpm via Corepack)
- **Build**: `pnpm build` (uses obuild)
- **Lint**: `pnpm lint` (ESLint + Prettier on `src test docs`)
- **Lint fix**: `pnpm lint:fix` (automd + ESLint fix + Prettier write)
- **Type check**: `pnpm test:types` (`tsc --noEmit --skipLibCheck`)
- **Test all**: `pnpm test` (lint + type check + vitest)
- **Run tests only**: `pnpm vitest run`
- **Run a single test**: `pnpm vitest run test/core/signer.test.ts`
- **Run tests in watch**: `pnpm vitest`
- **Benchmarks**: `pnpm bench`
- **Dev playground**: `pnpm dev` (listhen watching `playground/main.ts`)

## Architecture

### Entry points and exports

The package has three export paths defined in `package.json`:

- `.` → `src/index.ts` — re-exports `S3Client`, `S3Error`, all types, and `utils` namespace
- `./core` → `src/core.ts` — re-exports low-level internal core modules (signer, serializer, endpoint, transport, content-type, defaults)
- `./utils` → `src/utils.ts` — re-exports utility functions (MIME lookup, URI encoding, type guards)

### Key modules

- **`src/client.ts`** — `S3Client` class: high-level API (get, head, put, del, list, multipart, presigned URLs). Contains all retry logic, clock skew correction, checksum computation (SHA-256, CRC32C), and XML parsing for S3 responses. This is the largest file.
- **`src/error.ts`** — `S3Error` class with structured S3-specific error metadata (status, code, requestId, retriable, retryAfter, region).
- **`src/types.ts`** — All TypeScript interfaces and type definitions.

### Internal modules (`src/internal/`)

- **`core/signer.ts`** — AWS SigV4 request signing and presigned URL generation using Web Crypto HMAC-SHA256.
- **`core/endpoint.ts`** — URL construction supporting both virtual-hosted and path-style bucket addressing, with DNS compatibility checks.
- **`core/serializer.ts`** — Header building (conditional headers, range, cache-control), query parameter application, stream detection.
- **`core/content-type.ts`** — Content-type resolution from file extensions using the built-in MIME table.
- **`core/transport.ts`** — Thin fetch wrapper.
- **`core/defaults.ts`** — Constants (disallowed error headers).
- **`utils/mime.ts`** — Embedded MIME type lookup table (ported from mrmime).
- **`utils/encode.ts`** — RFC 3986 URI encoding.
- **`utils/is.ts`** — Runtime-safe type guards for ArrayBuffer, Blob, ReadableStream, DNS-compatible bucket names, plain objects.

### Build

Uses `obuild` with rolldown in `neutral` platform mode. Three bundle entry points: `index.ts`, `core.ts`, `utils.ts`. Output goes to `dist/` as `.mjs` files.

## Conventions

- ESLint config: `eslint-config-unjs` with `unicorn/no-null` and `unicorn/no-nested-ternary` disabled.
- Source files use `.ts` extensions in imports (e.g., `import { S3Error } from "./error.ts"`).
- No runtime dependencies — all crypto uses `crypto.subtle`, all HTTP uses `fetch`.
- XML responses are parsed with simple regex extraction (`extractTag`), not a DOM parser.
- The project is in active development / pre-1.0. Expect breaking changes.
