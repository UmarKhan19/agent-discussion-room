import { pi } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { config } from "./config";

export const piAgent = () =>
  pi(config.model, {
    thinking: config.thinking,
    captureSessions: true,
  });

export const dockerSandbox = (authPath?: string) =>
  docker({
    imageName: config.imageName,
    cpus: config.cpus,
    env: {
      PI_TELEMETRY: "0",
    },
    mounts: authPath
      ? [
          {
            hostPath: authPath,
            sandboxPath: "/home/agent/.pi/agent/auth.json",
            readonly: true,
          },
        ]
      : [],
  });
