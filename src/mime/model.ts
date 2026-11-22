import type { MimeTable } from "../types.ts";

/**
 * 3D models and scenes.
 *
 * @example
 * ```ts
 * import { createContentTypeResolver } from "uns3/mime";
 * import { model } from "uns3/mime/model";
 *
 * const contentTypeResolver = createContentTypeResolver(model);
 * ```
 */
export const model: MimeTable = Object.freeze({
  "glb": "model/gltf-binary",
  "gltf": "model/gltf+json",
  "obj": "model/obj",
  "mtl": "model/mtl",
  "stl": "model/stl",
  "3mf": "model/3mf",
  "usdz": "model/vnd.usdz+zip",
  "dae": "model/vnd.collada+xml",
  "x3d": "model/x3d+xml",
});

export default model;
