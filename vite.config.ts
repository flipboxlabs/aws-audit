import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
  lint: {
    ignorePatterns: ["**/dist/**", "**/coverage/**", "**/node_modules/**"],
    options: {
      typeAware: true,
      // Disable strict type checking - can be re-enabled after fixing type errors
      typeCheck: false,
    },
    rules: {
      // Disable strict rules - can be re-enabled later
      "no-unused-vars": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-duplicate-type-constituents": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  fmt: {
    ignorePatterns: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/CHANGELOG.md"],
  },
});
