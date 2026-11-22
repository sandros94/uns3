import type { MimeTable } from "../types.ts";

/**
 * Audio files and streams.
 *
 * Pass it to `createContentTypeResolver` from `uns3/mime`, alone or with other groups.
 */
export const audio: MimeTable = Object.freeze({
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  weba: "audio/webm",
  mid: "audio/midi",
  midi: "audio/midi",
});

export default audio;
