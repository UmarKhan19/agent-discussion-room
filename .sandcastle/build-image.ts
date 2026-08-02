#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { config } from "./config";

const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;
const child = spawn(
  "docker",
  [
    "build",
    "--file",
    ".sandcastle/Dockerfile",
    "--build-arg",
    `AGENT_UID=${uid}`,
    "--build-arg",
    `AGENT_GID=${gid}`,
    "--tag",
    config.imageName,
    ".",
  ],
  { cwd: config.repoRoot, stdio: "inherit" },
);

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
