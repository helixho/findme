import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { GatewayRequestError, classifyGatewayError } from "../src/llm/gateway.js";

describe("gateway provider error classification", () => {
  const headers = new Headers();
  it("classifies paid-provider failures without exposing provider messages", () => {
    expect(
      classifyGatewayError(new OpenAI.APIError(402, {}, "private balance text", headers)),
    ).toBe("quota");
    expect(
      classifyGatewayError(new OpenAI.RateLimitError(429, {}, "private rate text", headers)),
    ).toBe("rate_limit");
    expect(
      classifyGatewayError(new OpenAI.AuthenticationError(401, {}, "private auth text", headers)),
    ).toBe("authentication");
    expect(
      classifyGatewayError(new OpenAI.NotFoundError(404, {}, "private model text", headers)),
    ).toBe("model_not_found");
    expect(
      classifyGatewayError(new OpenAI.BadRequestError(400, {}, "private body text", headers)),
    ).toBe("bad_request");
    expect(classifyGatewayError(new GatewayRequestError("json_parse"))).toBe("json_parse");
  });
});
