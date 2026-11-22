import type { MimeTable } from "../types.ts";

/**
 * 3D models and scenes.
 *
 * Pass it to `createContentTypeResolver` from `uns3/mime`, alone or with other groups.
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
