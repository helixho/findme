import type { getPublishedClaim, listPublishedContent } from "../content/catalog.js";
export type PublishedClaimResolver = typeof getPublishedClaim;
export type PublishedContentLister = typeof listPublishedContent;
export function result<T>(body: T, status: 200 | 201 | 400 | 404 | 409 | 422 = 200) {
  return { body, status };
}
