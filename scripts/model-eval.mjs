#!/usr/bin/env node
import { readFileSync } from "node:fs";

const apiBase = process.env.FINDME_API ?? "http://127.0.0.1:8000";
const token = process.env.FINDME_SESSION_TOKEN;
if (!token) {
  console.error("需设置 FINDME_SESSION_TOKEN(登录后 session token,不要使用服务端 secret)");
  process.exit(1);
}

const cases = JSON.parse(readFileSync(new URL("./model-eval-cases.json", import.meta.url), "utf8"));

for (const item of cases) {
  const started = Date.now();
  const res = await fetch(`${apiBase}/api/insights/ask`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ question: item.question }),
  });
  const latencyMs = Date.now() - started;
  const body = await res.json().catch(() => ({}));
  const insight = body.insight ?? null;
  const evidenceCount = insight?.evidence_record_ids?.length ?? 0;
  const inferenceCount = insight?.inferences?.length ?? 0;
  const hasUnsupportedInference =
    inferenceCount > 0 && evidenceCount === 0 && insight?.sufficient !== false;
  console.log(
    JSON.stringify({
      id: item.id,
      status: res.status,
      latencyMs,
      recordCount: body.recordCount ?? null,
      evidenceCount,
      inferenceCount,
      sufficient: insight?.sufficient ?? null,
      hasUnsupportedInference,
      title: insight?.title ?? null,
      expectation: item.expectation,
    }),
  );
}
