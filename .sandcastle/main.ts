#!/usr/bin/env bun
import { config } from "./config";
import { dryRunFeature, runFeature } from "./orchestrator";

interface CliOptions {
  feature: string;
  maxParallel: number;
  dryRun: boolean;
  resume: boolean;
}

const usage = () => {
  console.log(`Usage: bun .sandcastle/main.ts [options]

Options:
  --feature <slug>        Ticket feature directory (default: production-hardening)
  --max-parallel <count> Maximum concurrent independent tickets
  --dry-run               Print the dependency execution waves only
  --resume                Resume the last failed/active feature run
  --help                  Show this help
`);
};

const parseArgs = (args: string[]): CliOptions => {
  const options: CliOptions = {
    feature: process.env.SANDCASTLE_FEATURE ?? "production-hardening",
    maxParallel: config.maxParallel,
    dryRun: false,
    resume: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--feature": {
        const value = args[++index];
        if (!value) throw new Error("--feature requires a value");
        options.feature = value;
        break;
      }
      case "--max-parallel": {
        const value = Number(args[++index]);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error("--max-parallel requires a positive integer");
        }
        options.maxParallel = value;
        break;
      }
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--resume":
        options.resume = true;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.dryRun) {
    const plan = await dryRunFeature(options.feature, options.maxParallel);
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const state = await runFeature({
    feature: options.feature,
    maxParallel: options.maxParallel,
    resume: options.resume,
  });
  console.log(
    `Sandcastle run ${state.runId} completed; ${state.targetBranch} now points at the verified integration branch.`,
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
