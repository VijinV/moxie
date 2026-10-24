import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  // Don't watch the Rust side: cargo locks files in src-tauri/target while building.
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022", outDir: "dist" },
});
