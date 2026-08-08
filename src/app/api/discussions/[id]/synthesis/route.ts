import { discussionHttpHandlers } from "../../composition";

type DiscussionSynthesisRouteContext = { params: Promise<{ id: string }> };

/**
 * Server-owned synthesis retry/resume. The request carries no body and no
 * Turn request identity: ownership comes from the signed session cookie,
 * the resource from the Discussion id in the URL, and the retry decision
 * from the persisted `synthesis` sub-state. A retryable or missing
 * synthesis is therefore recoverable from the canonical Discussion URL in
 * a fresh tab with only the ownership cookie.
 */
export async function POST(
  request: Request,
  context: DiscussionSynthesisRouteContext,
): Promise<Response> {
  const { id } = await context.params;
  return (await discussionHttpHandlers).postSynthesisRetry(request, id);
}
