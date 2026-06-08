import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@renderer": resolve(__dirname, "src/renderer")
    }
  },
  build: {
    outDir: "dist-renderer",
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
