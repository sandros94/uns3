# Changelog

## v0.0.7

[compare changes](https://github.com/sandros94/uns3/compare/v0.0.6...v0.0.7)

### 🚀 Enhancements

- **client:** Add filtering of disallowed headers from error responses ([152bf6e](https://github.com/sandros94/uns3/commit/152bf6e))

### 🔥 Performance

- **core:** Improve `toHex` signer ([658601b](https://github.com/sandros94/uns3/commit/658601b))

### 🩹 Fixes

- Make `region` optional ([2a1eee7](https://github.com/sandros94/uns3/commit/2a1eee7))
- Do not require `ETag` in `ListObjectsV2` ([9f2e201](https://github.com/sandros94/uns3/commit/9f2e201))

### 📖 Documentation

- Rewrite original plan and better list what's missing ([9e189cd](https://github.com/sandros94/uns3/commit/9e189cd))
- Add JSDoc to all public exports with examples ([56ada3c](https://github.com/sandros94/uns3/commit/56ada3c))

### 📦 Build

- Add rolldown platform configuration ([3f669d3](https://github.com/sandros94/uns3/commit/3f669d3))

### 🌊 Types

- Fix override cause ([1e1379c](https://github.com/sandros94/uns3/commit/1e1379c))

### 🏡 Chore

- Switch to obuild ([2d62c0c](https://github.com/sandros94/uns3/commit/2d62c0c))
- Use eslint cache and specify prettier targets ([e69a5cf](https://github.com/sandros94/uns3/commit/e69a5cf))
- Restructure project files and simplify build output ([128c8be](https://github.com/sandros94/uns3/commit/128c8be))
- Add `AGENTS.md` ([2f77378](https://github.com/sandros94/uns3/commit/2f77378))
- Update readme badges ([aac9711](https://github.com/sandros94/uns3/commit/aac9711))
- Switch to oxc and tsgo, update deps ([0356b76](https://github.com/sandros94/uns3/commit/0356b76))
- Apply automated updates ([d81562c](https://github.com/sandros94/uns3/commit/d81562c))
- Improve internal docs ([bb1efcb](https://github.com/sandros94/uns3/commit/bb1efcb))
- Setup nano-staged ([342cc19](https://github.com/sandros94/uns3/commit/342cc19))
- Fix format ([d1a9df6](https://github.com/sandros94/uns3/commit/d1a9df6))
- Update pnpm ([8b590c0](https://github.com/sandros94/uns3/commit/8b590c0))

### ✅ Tests

- Fix imports ([f702f26](https://github.com/sandros94/uns3/commit/f702f26))

### 🤖 CI

- Revert by separating autofix ci ([ce4375f](https://github.com/sandros94/uns3/commit/ce4375f))
- Refactor workflows ([ff69c7a](https://github.com/sandros94/uns3/commit/ff69c7a))

### ❤️ Contributors

- Sandro Circi ([@sandros94](https://github.com/sandros94))

## v0.0.6

[compare changes](https://github.com/sandros94/uns3/compare/v0.0.5...v0.0.6)

### 🩹 Fixes

- **client:** Prevent canceling response body if already used and improve error body reading ([f84d674](https://github.com/sandros94/uns3/commit/f84d674))

### ❤️ Contributors

- Sandro Circi ([@sandros94](https://github.com/sandros94))

## v0.0.5

[compare changes](https://github.com/sandros94/uns3/compare/v0.0.4...v0.0.5)

### 🩹 Fixes

- **client:** Enhance credential handling and add anonymous support ([9085ce3](https://github.com/sandros94/uns3/commit/9085ce3))

### 🏡 Chore

- Update deps ([711ed9d](https://github.com/sandros94/uns3/commit/711ed9d))
- Update babel packages to latest versions ([f16c135](https://github.com/sandros94/uns3/commit/f16c135))

### 🤖 CI

- Unify jobs and run autofix only when required ([a7c9375](https://github.com/sandros94/uns3/commit/a7c9375))
- Add publish workflow ([bf906bb](https://github.com/sandros94/uns3/commit/bf906bb))
- Update release script ([392a067](https://github.com/sandros94/uns3/commit/392a067))

### ❤️ Contributors

- Sandro Circi ([@sandros94](https://github.com/sandros94))

## v0.0.4

[compare changes](https://github.com/sandros94/uns3/compare/v0.0.3...v0.0.4)

### 🩹 Fixes

- **client:** Improve support for conditional requests and responses methods ([50c6981](https://github.com/sandros94/uns3/commit/50c6981))

### ❤️ Contributors

- Sandro Circi ([@sandros94](https://github.com/sandros94))

## v0.0.3

[compare changes](https://github.com/sandros94/uns3/compare/v0.0.2...v0.0.3)

### 🚀 Enhancements

- **error:** Enhance S3Error to include cause information ([b6e89c2](https://github.com/sandros94/uns3/commit/b6e89c2))

### 🩹 Fixes

- **signer:** Prevent double-encoding of URL pathname segments ([0280988](https://github.com/sandros94/uns3/commit/0280988))

### 📖 Documentation

- Update `put` examples ([007a376](https://github.com/sandros94/uns3/commit/007a376))

### ❤️ Contributors

- Sandro Circi ([@sandros94](https://github.com/sandros94))

## v0.0.2

[compare changes](https://github.com/sandros94/uns3/compare/v0.0.1...v0.0.2)

### 🚀 Enhancements

- **client:** `put` automatically stringify and set content type for plain objects ([d82f2f2](https://github.com/sandros94/uns3/commit/d82f2f2))

### 🩹 Fixes

- Optional `list` param ([57c123c](https://github.com/sandros94/uns3/commit/57c123c))
- Handle keys with leading slashes ([b689ff5](https://github.com/sandros94/uns3/commit/b689ff5))

### 🏡 Chore

- Update prettierignore ([d8bf4ab](https://github.com/sandros94/uns3/commit/d8bf4ab))

### 🤖 CI

- Init ([16664f7](https://github.com/sandros94/uns3/commit/16664f7))

### ❤️ Contributors

- Sandro Circi ([@sandros94](https://github.com/sandros94))

## v0.0.1

### 🚀 Enhancements

- Initial implementation ([3934d78](https://github.com/sandros94/uns3/commit/3934d78))
- Enhance S3Client with retry logic and checksum support; update endpoint handling for DNS compliance ([3926843](https://github.com/sandros94/uns3/commit/3926843))
- Implement multipart upload functionality in S3Client; add methods for initiating, uploading parts, completing, and aborting uploads ([fa72043](https://github.com/sandros94/uns3/commit/fa72043))

### 🩹 Fixes

- Remove old concepts ([e5b60f8](https://github.com/sandros94/uns3/commit/e5b60f8))
- `formatAmzDate` ([9bb2419](https://github.com/sandros94/uns3/commit/9bb2419))

### 📖 Documentation

- Project plan structure ([ef446d4](https://github.com/sandros94/uns3/commit/ef446d4))
- Update README.md with usage examples ([a912df9](https://github.com/sandros94/uns3/commit/a912df9))

### 🏡 Chore

- Init ([b7c2011](https://github.com/sandros94/uns3/commit/b7c2011))
- Update scripts ([06a4a01](https://github.com/sandros94/uns3/commit/06a4a01))
- Setup ts, eslint and build ([3412588](https://github.com/sandros94/uns3/commit/3412588))

### ✅ Tests

- Init ([8a69221](https://github.com/sandros94/uns3/commit/8a69221))

### ❤️ Contributors

- Sandro Circi ([@sandros94](https://github.com/sandros94))
