import { defineProject } from "vite-plus";

export default defineProject({
  test: {
    name: "cdk",
    setupFiles: ["./src/test-setup.ts"],
  },
});
