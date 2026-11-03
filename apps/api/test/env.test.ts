import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/env.js";

const ok = {
  DATABASE_URL: "postgres://u:p@h:5432/d",
  APP_LOGIN_PASSWORD: "pw",
  LLM_DEFAULT_PROVIDER: "deepseek",
  DEEPSEEK_MODEL: "test-model", // 必填(B3:不在代码/计划固化具体型号)
};

describe("parseEnv", () => {
  it("缺 DATABASE_URL_RUNTIME 与 DATABASE_URL 时抛错", () => {
    expect(() => parseEnv({ APP_LOGIN_PASSWORD: "x" })).toThrow();
  });
  it("缺 DEEPSEEK_MODEL 时抛错(必填,无默认)", () => {
    const { DEEPSEEK_MODEL, ...rest } = ok;
    expect(() => parseEnv(rest)).toThrow();
  });
  it("合法 env 解析通过", () => {
    expect(parseEnv(ok).APP_LOGIN_PASSWORD).toBe("pw");
  });
  it("优先使用 DATABASE_URL_RUNTIME,兼容 DATABASE_URL 兜底", () => {
    expect(
      parseEnv({
        DATABASE_URL: "postgres://u:p@h:5432/legacy",
        DATABASE_URL_RUNTIME: "postgres://u:p@h:5432/runtime",
        APP_LOGIN_PASSWORD: "pw",
        DEEPSEEK_MODEL: "test-model",
      }).DATABASE_URL_RUNTIME,
    ).toBe("postgres://u:p@h:5432/runtime");
    expect(parseEnv(ok).DATABASE_URL_RUNTIME).toBe(ok.DATABASE_URL);
  });
  it("默认无鉴权时不需要登录密码", () => {
    expect(
      parseEnv({ DATABASE_URL: "postgres://u:p@h:5432/d", DEEPSEEK_MODEL: "test-model" })
        .APP_AUTH_MODE,
    ).toBe("none");
  });
  it("会话鉴权启用时缺登录密码抛错", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgres://u:p@h:5432/d",
        APP_AUTH_MODE: "session",
        DEEPSEEK_MODEL: "test-model",
      }),
    ).toThrow();
  });
  it("固定 token 鉴权启用时需要 APP_ACCESS_TOKEN", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgres://u:p@h:5432/d",
        APP_AUTH_MODE: "static",
        DEEPSEEK_MODEL: "test-model",
      }),
    ).toThrow();
    expect(
      parseEnv({
        DATABASE_URL: "postgres://u:p@h:5432/d",
        APP_AUTH_MODE: "static",
        APP_ACCESS_TOKEN: "token",
        DEEPSEEK_MODEL: "test-model",
      }).APP_AUTH_MODE,
    ).toBe("static");
  });
});
