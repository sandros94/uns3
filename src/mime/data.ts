import type { MimeTable } from "../types.ts";

/**
 * Data files: tables, columnar and streaming formats, configuration and
 * geodata.
 *
 * Pass it to `createContentTypeResolver` from `uns3/mime`, alone or with other groups.
 */
export const data: MimeTable = Object.freeze({
  parquet: "application/vnd.apache.parquet",
  arrow: "application/vnd.apache.arrow.file",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  ndjson: "application/x-ndjson",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  geojson: "application/geo+json",
});

export default data;
