import { defineProject } from "vite-plus";

export default defineProject({
  test: {
    name: "sdk",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.test.js"],
  },
});
