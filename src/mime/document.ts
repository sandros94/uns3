import type { MimeTable } from "../types.ts";

/**
 * Office documents, PDFs, e-books and plain text.
 *
 * Pass it to `createContentTypeResolver` from `uns3/mime`, alone or with other groups.
 */
export const document: MimeTable = Object.freeze({
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "text/rtf",
  epub: "application/epub+zip",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
});

export default document;
