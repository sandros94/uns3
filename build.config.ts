/// <reference types="node" />

import { readdirSync } from "fs";

import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "./src/index.ts",
        "./src/signer.ts",
        "./src/endpoint.ts",
        "./src/mime.ts",
        ...readdirSync("./src/mime").map((file) => `./src/mime/${file}`),
      ],
      rolldown: {
        platform: "neutral",
      },
    },
  ],
});
