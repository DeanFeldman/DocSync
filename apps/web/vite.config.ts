import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version?: unknown };
if (
  typeof rootPackage.version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(rootPackage.version)
) {
  throw new Error(
    "The root package.json must contain a valid semantic version for the DocSync badge.",
  );
}

export default defineConfig({
  define: {
    __DOCSYNC_VERSION__: JSON.stringify(rootPackage.version),
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8001",
    },
  },
});
