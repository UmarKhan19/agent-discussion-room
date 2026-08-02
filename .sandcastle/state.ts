import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RunTicketStatus, TicketStatusMap } from "./scheduler";
import { assertFeatureSlug } from "./tickets";

export interface TicketRunRecord {
  status: RunTicketStatus;
  attempt: number;
  branch?: string;
  baseSha?: string;
  headSha?: string;
  error?: string;
}

export interface RunState {
  version: 1;
  runId: string;
  feature: string;
  status: "active" | "finalizing" | "completed" | "failed";
  targetBranch: string;
  targetStartSha: string;
  integrationBranch: string;
  lastIntegratedSha: string;
  verifiedIntegrationSha?: string;
  startedAt: string;
  updatedAt: string;
  tickets: Record<string, TicketRunRecord>;
}

export const createRunId = () =>
  `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;

const assertStoredState = (value: unknown, feature: string): RunState => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Sandcastle state must be an object");
  }
  const state = value as Partial<RunState>;
  if (state.version !== 1 || state.feature !== feature) {
    throw new Error(`Sandcastle state does not belong to feature ${feature}`);
  }
  if (!state.runId || !/^[A-Za-z0-9._-]+$/.test(state.runId)) {
    throw new Error("Sandcastle state contains an invalid runId");
  }
  const integrationPrefix = `sandcastle/integration/${feature}/`;
  if (
    !state.integrationBranch?.startsWith(integrationPrefix) ||
    state.integrationBranch.includes("..")
  ) {
    throw new Error("Sandcastle state contains an invalid integration branch");
  }
  for (const [label, sha] of [
    ["targetStartSha", state.targetStartSha],
    ["lastIntegratedSha", state.lastIntegratedSha],
  ] as const) {
    if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) {
      throw new Error(`Sandcastle state contains an invalid ${label}`);
    }
  }
  if (
    state.verifiedIntegrationSha &&
    !/^[0-9a-f]{40,64}$/.test(state.verifiedIntegrationSha)
  ) {
    throw new Error("Sandcastle state contains an invalid verifiedIntegrationSha");
  }
  if (typeof state.tickets !== "object" || state.tickets === null) {
    throw new Error("Sandcastle state contains invalid ticket records");
  }
  return state as RunState;
};

export class StateStore {
  readonly feature: string;
  readonly directory: string;
  readonly statePath: string;
  readonly eventsPath: string;
  readonly lockPath: string;

  constructor(sandcastleDir: string, feature: string) {
    assertFeatureSlug(feature);
    this.feature = feature;
    this.directory = join(sandcastleDir, "state");
    this.statePath = join(this.directory, `${feature}.json`);
    this.eventsPath = join(this.directory, `${feature}.events.jsonl`);
    this.lockPath = join(this.directory, `${feature}.lock`);
  }

  async acquire(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true });
    const token = randomUUID();
    const ownerPath = join(this.lockPath, "owner.json");
    try {
      await mkdir(this.lockPath, { mode: 0o700 });
      await writeFile(
        ownerPath,
        `${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
    } catch (error) {
      const detail = error as NodeJS.ErrnoException;
      if (detail.code !== "EEXIST") {
        await rm(this.lockPath, { recursive: true, force: true });
        throw error;
      }

      let owner = "unknown owner";
      try {
        const parsed = JSON.parse(await readFile(ownerPath, "utf8")) as {
          pid?: number;
          createdAt?: string;
        };
        owner = `PID ${parsed.pid ?? "unknown"} since ${parsed.createdAt ?? "unknown"}`;
      } catch {
        // Keep the conservative unknown-owner message.
      }
      throw new Error(
        `Sandcastle feature lock already exists at ${this.lockPath} (${owner}). ` +
          "Do not delete it until you have confirmed the owning process is gone.",
      );
    }

    return async () => {
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
        token?: string;
      };
      if (owner.token !== token) {
        throw new Error(`Refusing to release a Sandcastle lock owned by another process`);
      }
      await rm(this.lockPath, { recursive: true });
    };
  }

  async load(): Promise<RunState | undefined> {
    try {
      return assertStoredState(
        JSON.parse(await readFile(this.statePath, "utf8")),
        this.feature,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(state: RunState, event: Record<string, unknown>): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.statePath);
    await appendFile(
      this.eventsPath,
      `${JSON.stringify({ at: state.updatedAt, runId: state.runId, ...event })}\n`,
      { mode: 0o600 },
    );
  }
}

export const stateStatuses = (state: RunState): TicketStatusMap =>
  Object.fromEntries(
    Object.entries(state.tickets).map(([id, record]) => [id, record.status]),
  );
