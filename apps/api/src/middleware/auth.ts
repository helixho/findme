import { createMiddleware } from "hono/factory";

export const bearerAuth = (token: string) =>
  createMiddleware(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    if (header !== `Bearer ${token}`) {
      return c.json({ error: { code: "unauthorized", message: "无效令牌" } }, 401);
    }
    await next();
  });
