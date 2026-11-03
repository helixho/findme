import { KnowledgeFeedbackInput, KnowledgeTopicProcessInput } from "@findme/core";
import type { Db } from "@findme/db";
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { withProfileTransaction } from "../cloud-diagnostic/scope.js";
import type { PersonalContext } from "../core/exploration-service.js";
import {
  getKnowledgeTopic,
  getKnowledgeTopicVersions,
  listKnowledgeTopics,
  processKnowledgeTopic,
  recordKnowledgeFeedback,
} from "../knowledge-processing/service.js";

export type KnowledgeContextResolver = (c: Context) => Promise<PersonalContext>;

const TopicKey = z.string().trim().min(1).max(120);

export function knowledgeRoutes(db: Db, resolveContext: KnowledgeContextResolver) {
  const routes = new Hono();
  const withinProfile = <T>(c: Context, work: (tx: Db, ctx: PersonalContext) => Promise<T>) =>
    resolveContext(c).then((ctx) =>
      withProfileTransaction(db, ctx, (tx) => work(tx as unknown as Db, ctx)),
    );

  routes.get("/topics", async (c) =>
    c.json(await withinProfile(c, (tx, ctx) => listKnowledgeTopics(tx, ctx))),
  );

  routes.get("/topics/:topicKey", async (c) => {
    const topicKey = TopicKey.parse(c.req.param("topicKey"));
    const record = await withinProfile(c, (tx, ctx) => getKnowledgeTopic(tx, ctx, topicKey));
    return record ? c.json(record) : c.json({ error: "TOPIC_NOT_FOUND" }, 404);
  });

  routes.get("/topics/:topicKey/versions", async (c) => {
    const topicKey = TopicKey.parse(c.req.param("topicKey"));
    const versions = await withinProfile(c, (tx, ctx) =>
      getKnowledgeTopicVersions(tx, ctx, topicKey),
    );
    return c.json(versions);
  });

  routes.post("/topics/process", zValidator("json", KnowledgeTopicProcessInput), async (c) => {
    const input = c.req.valid("json");
    return c.json(await withinProfile(c, (tx, ctx) => processKnowledgeTopic(tx, ctx, input)), 201);
  });

  routes.post(
    "/topics/:topicKey/feedback",
    zValidator("json", KnowledgeFeedbackInput),
    async (c) => {
      const topicKey = TopicKey.parse(c.req.param("topicKey"));
      const input = c.req.valid("json");
      return c.json(
        await withinProfile(c, (tx, ctx) => recordKnowledgeFeedback(tx, ctx, input, topicKey)),
        201,
      );
    },
  );

  return routes;
}
