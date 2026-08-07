import { resolveDiscussionEnvironment } from "@/config/environment";
import {
  ScriptedScenarioSchema,
  currentScriptedScenario,
  setScriptedScenario,
} from "@/discussion/scripted-discussion";

/**
 * Test-harness control for the deterministic browser suite.
 *
 * Serves only while `DISCUSSION_GENERATION_MODE=deterministic` is active —
 * a development/test-only mode that the environment contract rejects in
 * production — and 404s like a nonexistent route in every other
 * configuration, so the endpoint is unreachable in any production-shaped
 * process. It reconfigures the scripted, credential-free generation
 * adapter; it never touches providers, storage, or real Discussions.
 */

function harnessEnabled(): boolean {
  try {
    return (
      resolveDiscussionEnvironment(process.env).generationMode ===
      "deterministic"
    );
  } catch {
    // Any environment misconfiguration disables the harness; production can
    // never enable the deterministic mode in the first place.
    return false;
  }
}

const disabledResponse = () =>
  new Response(null, { status: 404, statusText: "Not Found" });

export async function POST(request: Request): Promise<Response> {
  if (!harnessEnabled()) return disabledResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      {
        error: {
          code: "MALFORMED_REQUEST",
          message: "The scenario body is not valid JSON.",
        },
      },
      { status: 400 },
    );
  }

  const parsed = ScriptedScenarioSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: {
          code: "INVALID_SCENARIO",
          message: "The scenario does not match the scripted-turn contract.",
        },
      },
      { status: 400 },
    );
  }

  setScriptedScenario(parsed.data);
  return Response.json({ ok: true });
}

export async function GET(): Promise<Response> {
  if (!harnessEnabled()) return disabledResponse();
  return Response.json({ scenario: currentScriptedScenario() });
}
