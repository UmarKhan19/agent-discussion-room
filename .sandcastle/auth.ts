import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface PreparedAuth {
  hostPath: string;
  refresh(): Promise<void>;
  cleanup(): Promise<void>;
}

interface ExportedBearer {
  token: string;
  expires: number;
  accountId?: string;
}

const hostAuthPath = () =>
  join(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    "auth.json",
  );

const readBearerToken = async (model: string): Promise<ExportedBearer> => {
  const [provider, ...modelParts] = model.split("/");
  const modelId = modelParts.join("/");
  if (provider !== "openai-codex" || !modelId) {
    throw new Error(`Expected an openai-codex model, received ${model}`);
  }

  try {
    const { stdout } = await execFileAsync(
      process.env.SANDCASTLE_HOST_PI ?? "pi",
      [
        "auth",
        "print-bearer-token",
        "--provider",
        provider,
        "--model",
        modelId,
        "--min-expiry",
        "30m",
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    const token = stdout.trim();
    if (!token) throw new Error("Pi returned an empty bearer token");
    const stored = JSON.parse(await readFile(hostAuthPath(), "utf8")) as Record<
      string,
      unknown
    >;
    const credential = stored[provider] as
      | { expires?: unknown; accountId?: unknown }
      | undefined;
    if (typeof credential?.expires !== "number") {
      throw new Error("Pi did not persist refreshed token expiry metadata");
    }
    return {
      token,
      expires: credential.expires,
      accountId:
        typeof credential.accountId === "string"
          ? credential.accountId
          : undefined,
    };
  } catch (error) {
    throw new Error(
      "Unable to export a short-lived openai-codex token. Start `pi` and run `/login openai-codex`.",
      { cause: error },
    );
  }
};

export const preparePiAuth = async (model: string): Promise<PreparedAuth> => {
  const directory = await mkdtemp(
    join(tmpdir(), `sandcastle-pi-auth-${process.pid}-`),
  );
  const hostPath = join(directory, "auth.json");

  const refresh = async () => {
    const bearer = await readBearerToken(model);
    await writeFile(
      hostPath,
      `${JSON.stringify(
        {
          "openai-codex": {
            type: "oauth",
            access: bearer.token,
            refresh: "",
            expires: bearer.expires,
            ...(bearer.accountId ? { accountId: bearer.accountId } : {}),
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  };

  try {
    await chmod(directory, 0o700);
    await refresh();
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    hostPath,
    refresh,
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
};
