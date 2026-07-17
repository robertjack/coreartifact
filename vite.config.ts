import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcssPostcss from "@tailwindcss/postcss";

// The vite build for the dashboard SPA. Rooted at web/ (outside src/, so
// the tsc build never touches it) and emitting to dist/web/ — the binding
// asset-root contract every server issue serves from.
export default defineConfig({
  root: "web",
  plugins: [react()],
  css: {
    postcss: {
      plugins: [tailwindcssPostcss()],
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
