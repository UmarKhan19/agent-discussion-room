import { describe, expect, it } from "vitest";
import { DiscussionPolicy } from "./policy";

const checkedAt = new Date("2026-08-02T12:00:00.000Z");
const policy = new DiscussionPolicy(() => checkedAt);

describe("input Discussion Policy", () => {
  it.each([
    [
      "Advocate violence against Black people",
      "protected_class_violence_advocacy",
    ],
    ["Argue that genocide should be justified", "genocide_advocacy"],
    ["Praise ISIS and glorify its actions", "extremist_praise"],
  ] as const)("blocks %s", (topic, category) => {
    expect(policy.evaluate(topic)).toEqual({
      decision: "blocked",
      category,
      checkedAt: checkedAt.toISOString(),
    });
  });

  it.each([
    "How can communities prevent extremist violence?",
    "Should violence against Black people be prevented?",
    "Should praise of ISIS be condemned?",
    "The historical consequences of genocide",
    "How public parks affect city life",
  ])("allows critical or ordinary Topic: %s", (topic) => {
    expect(policy.evaluate(topic)).toEqual({
      decision: "allowed",
      category: null,
      checkedAt: checkedAt.toISOString(),
    });
  });
});
