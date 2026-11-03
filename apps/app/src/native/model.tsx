import { ApiError } from "../api";

export type View = "home" | "compose" | "planning" | "question" | "result" | "current";

export type Overlay = "evidence" | "correction" | "amendment" | null;

export function isUnauthorized(error: unknown) {
  return error instanceof ApiError && error.status === 401;
}
