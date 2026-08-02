import type { Sandbox } from "@ai-hero/sandcastle";

export interface VerificationCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface VerificationReport {
  ok: boolean;
  commands: VerificationCommandResult[];
}

const bounded = (value: string, limit = 16_000) =>
  value.length <= limit ? value : `${value.slice(0, limit)}\n...[truncated]`;

const packageScripts = async (sandbox: Sandbox): Promise<Set<string>> => {
  const result = await sandbox.exec(
    `node -e 'const p=require("./package.json"); console.log(JSON.stringify(Object.keys(p.scripts || {})))'`,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Unable to read package scripts: ${result.stderr}`);
  }
  return new Set(JSON.parse(result.stdout.trim()) as string[]);
};

export const verifySandbox = async (
  sandbox: Sandbox,
): Promise<VerificationReport> => {
  const scripts = await packageScripts(sandbox);
  const commands = ["bun install --frozen-lockfile"];
  if (scripts.has("test:browser")) {
    commands.push(
      "sudo bunx playwright install-deps chromium",
      "bunx playwright install chromium",
    );
  }
  if (scripts.has("verify")) {
    commands.push("bun run verify");
  } else {
    commands.push("bun run lint", "bunx tsc --noEmit");
    if (scripts.has("test")) commands.push("bun run test");
    if (scripts.has("test:browser")) commands.push("bun run test:browser");
    commands.push("bun run build");
  }

  const results: VerificationCommandResult[] = [];
  for (const command of commands) {
    const result = await sandbox.exec(command, {
      onLine: (line) => console.log(`[verify] ${line}`),
    });
    results.push({
      command,
      exitCode: result.exitCode,
      stdout: bounded(result.stdout),
      stderr: bounded(result.stderr),
    });
    if (result.exitCode !== 0) break;
  }

  return {
    ok: results.length === commands.length && results.every((item) => item.exitCode === 0),
    commands: results,
  };
};

export const formatVerificationFailure = (report: VerificationReport) =>
  report.commands
    .filter((command) => command.exitCode !== 0)
    .map(
      (command) =>
        `$ ${command.command}\nexit ${command.exitCode}\nstdout:\n${command.stdout}\nstderr:\n${command.stderr}`,
    )
    .join("\n\n");
