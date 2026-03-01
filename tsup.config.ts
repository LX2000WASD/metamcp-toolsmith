import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/http.ts", "src/stdio.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  splitting: false,
  bundle: true,
  keepNames: true,
  minify: false,
  external: ["@modelcontextprotocol/sdk", "express"],
});

