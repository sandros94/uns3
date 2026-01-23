import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "./src/index.ts",
        "./src/core/index.ts",
        "./src/utils/index.ts",
      ],
    },
  ],
});
