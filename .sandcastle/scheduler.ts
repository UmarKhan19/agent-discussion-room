import type { Ticket } from "./tickets";

export type RunTicketStatus =
  | "pending"
  | "running"
  | "verifying"
  | "reviewing"
  | "fixing"
  | "integrated"
  | "failed"
  | "conflict";

export type TicketStatusMap = Record<string, RunTicketStatus | undefined>;

const successfulStatuses = new Set(["done", "integrated", "completed"]);

export const isIntegrated = (
  ticket: Ticket,
  statuses: TicketStatusMap,
): boolean =>
  statuses[ticket.id] === "integrated" ||
  successfulStatuses.has(ticket.status.toLowerCase());

const isRunnable = (ticket: Ticket, statuses: TicketStatusMap): boolean => {
  const runStatus = statuses[ticket.id];
  if (runStatus && runStatus !== "pending") return false;
  return ticket.status === "ready-for-agent";
};

export const selectReadyWave = (
  tickets: Ticket[],
  statuses: TicketStatusMap,
  maxParallel: number,
): Ticket[] => {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new Error("maxParallel must be a positive integer");
  }

  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  return [...tickets]
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((ticket) => isRunnable(ticket, statuses))
    .filter((ticket) =>
      ticket.blockedBy.every((blockerId) => {
        const blocker = byId.get(blockerId);
        return blocker ? isIntegrated(blocker, statuses) : false;
      }),
    )
    .slice(0, maxParallel);
};

export const planExecutionWaves = (
  tickets: Ticket[],
  maxParallel: number,
): string[][] => {
  const statuses: TicketStatusMap = {};
  const waves: string[][] = [];

  while (true) {
    const remaining = tickets.filter(
      (ticket) =>
        ticket.status === "ready-for-agent" && !isIntegrated(ticket, statuses),
    );
    if (remaining.length === 0) return waves;

    const wave = selectReadyWave(tickets, statuses, maxParallel);
    if (wave.length === 0) {
      const blocked = remaining.map((ticket) => ticket.id).sort().join(", ");
      throw new Error(`No executable ticket wave; blocked tickets: ${blocked}`);
    }

    waves.push(wave.map((ticket) => ticket.id));
    for (const ticket of wave) statuses[ticket.id] = "integrated";
  }
};
