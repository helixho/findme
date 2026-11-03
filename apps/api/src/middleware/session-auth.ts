import type { Db } from "@findme/db";
import { createMiddleware } from "hono/factory";
import { getSessionFromHeaders } from "../auth/session.js";

export const sessionAuth = (db: Db) =>
  createMiddleware(async (c, next) => {
    const session = await getSessionFromHeaders(db, c.req.raw.headers);
    if (!session) {
      return c.json({ error: { code: "unauthorized", message: "会话已失效,请重新登录" } }, 401);
    }
    await next();
  });
