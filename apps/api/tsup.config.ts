import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/standalone/setup.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  // 仅把 @findme/* 工作区包打进 bundle;node_modules 依赖(hono/openai/postgres 等)运行时解析
  noExternal: [/^@findme\//],
});
