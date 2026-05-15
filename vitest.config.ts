import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", "fixtures"],
    globals: false,
    reporters: ["default"],
  },
});
