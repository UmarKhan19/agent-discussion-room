import { describe, expect, it } from "vitest";
import { mastra } from "./index";

describe("production Mastra registry", () => {
  it("exposes only Discussion Room resources", () => {
    const agentIds = Object.values(mastra.listAgents())
      .map((agent) => agent.id)
      .sort();

    expect(agentIds).toEqual([
      "opponent-agent",
      "supporter-agent",
      "synthesizer-agent",
    ]);
    expect(mastra.listWorkflows()).toEqual({});
    expect(mastra.listTools()).toEqual({});
    expect(mastra.listScorers()).toEqual({});
  });

  it("configures explicit storage instead of the implicit in-memory fallback", () => {
    expect(mastra.getStorage()).toBeDefined();
  });
});
