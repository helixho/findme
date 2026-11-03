import type { Db } from "@findme/db";
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { withProfileTransaction } from "../cloud-diagnostic/scope.js";
import { getPublishedClaim, listPublishedContent } from "../content/catalog.js";
import type { PersonalContext } from "../core/exploration-service.js";
import {
  ConfirmBody,
  DecisionBody,
  ProposalBody,
  ReviewBody,
  SessionBody,
  SessionUpdateBody,
  idParams,
  sessionParams,
  sessionQuery,
} from "../specialist/contracts.js";
import {
  confirmProposal,
  createProposal,
  decideProposal,
  listCandidates,
  listProposals,
} from "../specialist/proposals.js";
import {
  createSession,
  getSession,
  listSessions,
  transitionSession,
  updateSession,
} from "../specialist/sessions.js";
import { getTrial, reviewTrial, transitionTrial } from "../specialist/trials.js";

type ContextResolver = (c: Context) => Promise<PersonalContext>;
type PublishedClaimResolver = (
  contentId: string,
  claimId: string,
) => ReturnType<typeof getPublishedClaim>;
type PublishedContentLister = typeof listPublishedContent;

function requireIdempotencyKey(c: Context) {
  const key = c.req.header("Idempotency-Key")?.trim();
  if (!key || key.length > 200) return null;
  return key;
}
export function specialistRoutes(
  db: Db,
  contextFor: ContextResolver,
  deps: {
    getPublishedClaim?: PublishedClaimResolver;
    listPublishedContent?: PublishedContentLister;
  } = {},
) {
  const r = new Hono<{ Variables: { specialistDb: Db; specialistCtx: PersonalContext } }>();
  const selectClaim = deps.getPublishedClaim ?? getPublishedClaim;
  const listContent = deps.listPublishedContent ?? listPublishedContent;
  const scopedDb = (c: { get(key: "specialistDb"): Db }) => c.get("specialistDb");

  r.use("*", async (c, next) => {
    const ctx = await contextFor(c);
    return withProfileTransaction(db, ctx, async (tx) => {
      c.set("specialistDb", tx as unknown as Db);
      c.set("specialistCtx", ctx);
      await next();
      return c.res;
    });
  });

  r.get("/adhd/sessions", async (c) => {
    const ctx = c.get("specialistCtx");
    const db = scopedDb(c);
    const response = await listSessions(db, ctx);
    return c.json(response.body, response.status);
  });

  r.post("/adhd/sessions", zValidator("json", SessionBody), async (c) => {
    const ctx = c.get("specialistCtx");
    const db = scopedDb(c);
    const idempotencyKey = requireIdempotencyKey(c);
    if (!idempotencyKey) return c.json({ error: "idempotency_key_required" }, 400);
    const response = await createSession(db, ctx, c.req.valid("json"), idempotencyKey);
    return c.json(response.body, response.status);
  });

  r.get("/adhd/sessions/:sessionId", async (c) => {
    const params = sessionParams.safeParse(c.req.param());
    if (!params.success) return c.json({ error: "invalid_session_id" }, 400);
    const ctx = c.get("specialistCtx");
    const db = scopedDb(c);
    const response = await getSession(db, ctx, params.data.sessionId);
    return c.json(response.body, response.status);
  });

  r.patch("/adhd/sessions/:sessionId", zValidator("json", SessionUpdateBody), async (c) => {
    const params = sessionParams.safeParse(c.req.param());
    if (!params.success) return c.json({ error: "invalid_session_id" }, 400);
    const ctx = c.get("specialistCtx");
    const db = scopedDb(c);
    const response = await updateSession(db, ctx, params.data.sessionId, c.req.valid("json"));
    return c.json(response.body, response.status);
  });

  for (const action of ["pause", "resume"] as const) {
    r.post(`/adhd/sessions/:sessionId/${action}`, async (c) => {
      const params = sessionParams.safeParse(c.req.param());
      const body = DecisionBody.safeParse(await c.req.json().catch(() => null));
      if (!params.success) return c.json({ error: "invalid_session_id" }, 400);
      if (!body.success) return c.json({ error: "invalid_request" }, 400);
      const ctx = c.get("specialistCtx");
      const db = scopedDb(c);
      const response = await transitionSession(db, ctx, params.data.sessionId, body.data, action);
      return c.json(response.body, response.status);
    });
  }

  r.get("/adhd/content-candidates", zValidator("query", sessionQuery), async (c) => {
    const ctx = c.get("specialistCtx");
    const db = scopedDb(c);
    const response = await listCandidates(db, ctx, c.req.valid("query").session_id, listContent);
    return c.json(response.body, response.status);
  });

  r.post("/adhd/sessions/:sessionId/proposals", zValidator("json", ProposalBody), async (c) => {
    const params = sessionParams.safeParse(c.req.param());
    if (!params.success) return c.json({ error: "invalid_session_id" }, 400);
    const ctx = c.get("specialistCtx");
    const db = scopedDb(c);
    const response = await createProposal(
      db,
      ctx,
      params.data.sessionId,
      c.req.valid("json"),
      requireIdempotencyKey(c),
      selectClaim,
    );
    return c.json(response.body, response.status);
  });

  r.get("/adhd/sessions/:sessionId/proposals", async (c) => {
    const params = sessionParams.safeParse(c.req.param());
    if (!params.success) return c.json({ error: "invalid_session_id" }, 400);
    const ctx = c.get("specialistCtx");
    const db = scopedDb(c);
    const response = await listProposals(db, ctx, params.data.sessionId);
    return c.json(response.body, response.status);
  });

  r.post("/proposals/:id/confirm", zValidator("json", ConfirmBody), async (c) => {
    const params = idParams.safeParse(c.req.param());
    if (!params.success) return c.json({ error: "invalid_proposal_id" }, 400);
    const ctx = c.get("specialistCtx");
    const db = scopedDb(c);
    const response = await confirmProposal(
      db,
      ctx,
      params.data.id,
      c.req.valid("json"),
      selectClaim,
    );
    return c.json(response.body, response.status);
  });

  for (const decision of ["reject", "pause"] as const) {
    r.post(`/proposals/:id/${decision}`, zValidator("json", DecisionBody), async (c) => {
      const params = idParams.safeParse(c.req.param());
      if (!params.success) return c.json({ error: "invalid_proposal_id" }, 400);
      const ctx = c.get("specialistCtx");
      const db = scopedDb(c);
      const response = await decideProposal(db, ctx, params.data.id, c.req.valid("json"), decision);
      return c.json(response.body, response.status);
    });
  }

  for (const action of ["pause", "resume"] as const) {
    r.post(`/trials/:id/${action}`, zValidator("json", DecisionBody), async (c) => {
      const params = idParams.safeParse(c.req.param());
      if (!params.success) return c.json({ error: "invalid_trial_id" }, 400);
      const ctx = c.get("specialistCtx");
      const db = scopedDb(c);
      const response = await transitionTrial(db, ctx, params.data.id, c.req.valid("json"), action);
      return c.json(response.body, response.status);
    });
  }

  r.post("/trials/:id/review", zValidator("json", ReviewBody), async (c) => {
    const params = idParams.safeParse(c.req.param());
    if (!params.success) return c.json({ error: "invalid_trial_id" }, 400);
    const ctx = c.get("specialistCtx");
    const db = scopedDb(c);
    const response = await reviewTrial(db, ctx, params.data.id, c.req.valid("json"));
    return c.json(response.body, response.status);
  });

  r.get("/trials/:id", async (c) => {
    const params = idParams.safeParse(c.req.param());
    if (!params.success) return c.json({ error: "invalid_trial_id" }, 400);
    const ctx = c.get("specialistCtx");
    const db = scopedDb(c);
    const response = await getTrial(db, ctx, params.data.id);
    return c.json(response.body, response.status);
  });

  return r;
}
