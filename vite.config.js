import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

export default defineConfig({
  plugins: [react()],
  base: "./",
  define: {
    // App's own version, read from package.json — used by the in-app
    // update checker (src/update-check.jsx) to compare against GitHub releases.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173 },
});
