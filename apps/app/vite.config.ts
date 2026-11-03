import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  envDir: process.env.FINDME_BROWSER_TEST === "1" ? false : undefined,
  server: {
    host: "127.0.0.1",
    port: 5174,
    fs: { allow: ["../.."] },
  },
});
