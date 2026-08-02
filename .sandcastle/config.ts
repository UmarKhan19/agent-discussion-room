import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sandcastleDir = dirname(fileURLToPath(import.meta.url));

const positiveInteger = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

export const config = {
  repoRoot: resolve(sandcastleDir, ".."),
  targetBranch: process.env.SANDCASTLE_TARGET_BRANCH ?? "main",
  imageName:
    process.env.SANDCASTLE_IMAGE ??
    "agent-discussion-room-sandcastle:0.1.0",
  model:
    process.env.SANDCASTLE_PI_MODEL ?? "openai-codex/gpt-5.6-sol",
  thinking: "high" as const,
  maxParallel: positiveInteger("SANDCASTLE_MAX_PARALLEL", 2),
  maxFixRounds: positiveInteger("SANDCASTLE_MAX_FIX_ROUNDS", 2),
  maxConflictReruns: positiveInteger("SANDCASTLE_MAX_CONFLICT_RERUNS", 2),
  cpus: positiveInteger("SANDCASTLE_CPUS", 2),
  idleTimeoutSeconds: positiveInteger("SANDCASTLE_IDLE_TIMEOUT_SECONDS", 900),
};
