import { discussionHttpHandlers } from "../composition";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return discussionHttpHandlers.get(request, id);
}
