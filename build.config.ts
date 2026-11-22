/// <reference types="node" />

import { readdirSync } from "fs";

import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "./src/index.ts",
        "./src/core.ts",
        "./src/utils.ts",
        "./src/mime.ts",
        ...readdirSync("./src/mime").map((file) => `./src/mime/${file}`),
      ],
      rolldown: {
        platform: "neutral",
      },
    },
  ],
});
