import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/env.js";

describe("parseEnv", () => {
  it("requires the runtime database connection", () => {
    expect(() => parseEnv({})).toThrow();
  });
  it("parses startup configuration with defaults", () => {
    const env = parseEnv({ DATABASE_URL_RUNTIME: "postgres://u:p@h:5432/runtime" });
    expect(env).toMatchObject({
      DATABASE_URL_RUNTIME: "postgres://u:p@h:5432/runtime",
      PORT: 8000,
      HOST: "127.0.0.1",
      DB_POOL_MAX: 3,
    });
  });
  it("does not read model configuration from the environment", () => {
    const env = parseEnv({
      DATABASE_URL_RUNTIME: "postgres://u:p@h:5432/runtime",
      DEEPSEEK_API_KEY: "ignored",
    });
    expect(env).not.toHaveProperty("DEEPSEEK_API_KEY");
  });
});
