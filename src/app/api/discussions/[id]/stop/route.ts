import { discussionHttpHandlers } from "../../composition";

type DiscussionStopRouteContext = { params: Promise<{ id: string }> };

export async function POST(
  request: Request,
  context: DiscussionStopRouteContext,
): Promise<Response> {
  const { id } = await context.params;
  return (await discussionHttpHandlers).postStop(request, id);
}
