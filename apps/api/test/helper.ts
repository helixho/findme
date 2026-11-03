import { createApp } from "../src/app.js";

type AppOpts = Parameters<typeof createApp>[0];

// 测试辅助:包装 createApp,自动注入 Authorization,使启用 bearer 鉴权后业务测试仍走正常路径。
// 鉴权本身(无/错 token → 401、/health 开放)由 app.test.ts 专门覆盖。
export function authedApp(opts: AppOpts) {
  const app = createApp(opts);
  const auth = { Authorization: `Bearer ${opts.accessToken}` };
  return {
    request: (input: string, init: RequestInit = {}) =>
      app.request(input, {
        ...init,
        headers: { ...auth, ...(init.headers as Record<string, string> | undefined) },
      }),
  };
}
