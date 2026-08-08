import { describe, expect, it } from "vitest";
import { buildSynthesisPrompt } from "./mastra-discussion";

describe("buildSynthesisPrompt", () => {
  it("labels the assistant as neutral and not a participant", () => {
    const prompt = buildSynthesisPrompt({ topic: "t", transcript: [] });
    expect(prompt).toContain("neutral synthesis assistant");
    expect(prompt).not.toMatch(/third debater(?!\b)/);
    expect(prompt).toMatch(/never take a side/);
  });

  it("serializes the debate transcript with speaker labels", () => {
    const prompt = buildSynthesisPrompt({
      topic: "Should cities create more public parks?",
      transcript: [
        { speaker: "supporter", content: "Parks improve air quality." },
        { speaker: "opponent", content: "Parks cost maintenance money." },
      ],
    });
    expect(prompt).toContain("Should cities create more public parks?");
    expect(prompt).toContain("Supporter: Parks improve air quality.");
    expect(prompt).toContain("Opponent: Parks cost maintenance money.");
  });

  it("instructs strict JSON output with exactly the bounded fields", () => {
    const prompt = buildSynthesisPrompt({ topic: "t", transcript: [] });
    expect(prompt).toContain('"strongestSupport"');
    expect(prompt).toContain('"strongestOpposition"');
    expect(prompt).toContain('"agreements"');
    expect(prompt).toContain('"unresolved"');
    expect(prompt).toContain('"claimsToVerify"');
    expect(prompt).toContain('"takeaway"');
    expect(prompt).toContain("STRICT JSON only");
  });

  it("requires neutrality and forbids inventing arguments", () => {
    const prompt = buildSynthesisPrompt({ topic: "t", transcript: [] });
    expect(prompt).toContain("argue neither side");
    expect(prompt).toContain("never invent arguments that did not appear");
  });
});
