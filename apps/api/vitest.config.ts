import { defineConfig } from "vitest/config";
import { vitestSelection } from "../../scripts/test-config.mjs";

export default defineConfig({
  // Vite must not discover local .env files, even with the clean child environment.
  envDir: false,
  test: {
    include: vitestSelection(process.env),
    passWithNoTests: false,
    allowOnly: false,
    coverage: {
      enabled: process.env.FINDME_TEST_COVERAGE === "1",
      provider: "v8",
      include: [
        "src/knowledge-processing/**",
        "src/specialist/**",
        "src/cloud-diagnostic/**",
        "src/core/source-*.ts",
      ],
      reportsDirectory: `../../coverage/api-${process.env.FINDME_TEST_GROUP}`,
      reporter: ["text-summary", "json-summary", "lcov"],
    },
    // 多个集成测试文件共用同一测试 Postgres;关闭文件级并行,串行执行,
    // 由各文件 beforeEach 清表保证隔离,避免跨文件在共享表上竞争。
    fileParallelism: false,
    // 远程 Neon 往返比本机数据库慢;仍保持单文件串行,避免超时留下异步写入。
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
