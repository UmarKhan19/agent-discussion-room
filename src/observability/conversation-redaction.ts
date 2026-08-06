import type { AnySpan, SpanOutputProcessor } from "@mastra/core/observability";

/**
 * Conversation redaction for exported Mastra spans.
 *
 * Mastra agent and model spans carry the full prompt in `input` (which
 * includes the Discussion Topic and the recent Transcript) and the raw
 * provider response in `output`, plus provider error text in `errorInfo`.
 * This processor strips those fields before any exporter sees the span,
 * while keeping attributes and metadata (model identifier, token usage,
 * latency, request identity) for operators.
 *
 * This is deliberately independent of generic secret filtering
 * (`SensitiveDataFilter`): conversation redaction must not depend on
 * secret-shaped values being detected.
 *
 * Free-text `errorInfo.message` is stripped along with stacks and payload
 * details: provider error messages can echo prompt or output fragments, so
 * exported error spans carry only structured error fields (`name`, `id`,
 * `domain`, `category`) — provider failures stay observable through stable
 * classifications only.
 */

type StructuredErrorInfo = Pick<
  NonNullable<AnySpan["errorInfo"]>,
  "id" | "name" | "domain" | "category"
>;

function redactErrorInfo(
  errorInfo: NonNullable<AnySpan["errorInfo"]>,
): StructuredErrorInfo {
  const { id, name, domain, category } = errorInfo;
  return { id, name, domain, category };
}

export class ConversationRedactionSpanProcessor implements SpanOutputProcessor {
  readonly name = "conversation-redaction";

  process(span?: AnySpan): AnySpan | undefined {
    if (span === undefined) return undefined;
    // Mastra's SpanErrorInfo type requires `message`, which redaction must
    // drop; the cast is confined to the redaction boundary and never touches
    // values — the returned object is `input`/`output`/`errorInfo`-stripped.
    return {
      ...span,
      input: undefined,
      output: undefined,
      errorInfo:
        span.errorInfo === undefined ? undefined : redactErrorInfo(span.errorInfo),
    } as AnySpan;
  }

  async shutdown(): Promise<void> {}
}
