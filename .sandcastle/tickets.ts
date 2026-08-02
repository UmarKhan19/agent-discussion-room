import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface Ticket {
  id: string;
  feature: string;
  number: string;
  slug: string;
  title: string;
  status: string;
  path: string;
  relativePath: string;
  parentPath: string;
  blockedBy: string[];
  body: string;
}

export interface TicketGraph {
  tickets: Ticket[];
  byId: Map<string, Ticket>;
}

interface ParsedTicket extends Omit<Ticket, "blockedBy"> {
  blockerPaths: string[];
}

const toRepoPath = (repoRoot: string, absolutePath: string) =>
  relative(repoRoot, absolutePath).split(sep).join("/");

export const assertFeatureSlug = (feature: string): void => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(feature)) {
    throw new Error(`Invalid feature slug: ${feature}`);
  }
};

const sectionLines = (body: string, heading: string): string[] | undefined => {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return undefined;

  const section: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^##\s+/.test(line)) break;
    section.push(line);
  }
  return section;
};

const parseTicket = (
  repoRoot: string,
  feature: string,
  path: string,
  filename: string,
  body: string,
): ParsedTicket => {
  const filenameMatch = /^(\d+)-(.+)\.md$/.exec(filename);
  if (!filenameMatch) {
    throw new Error(`Invalid ticket filename: ${toRepoPath(repoRoot, path)}`);
  }

  const [, number, slug] = filenameMatch;
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const status = /^Status:\s*(.+)$/m.exec(body)?.[1]?.trim();
  if (!title) throw new Error(`Missing title in ${toRepoPath(repoRoot, path)}`);
  if (!status)
    throw new Error(`Missing Status in ${toRepoPath(repoRoot, path)}`);

  const blockerSection = sectionLines(body, "Blocked by");
  if (!blockerSection) {
    throw new Error(
      `Missing Blocked by section in ${toRepoPath(repoRoot, path)}`,
    );
  }

  const blockerPaths: string[] = [];
  let sawNone = false;
  let sawBlocker = false;
  for (const line of blockerSection) {
    const item = line.trim();
    if (!item.startsWith("-")) continue;
    if (/^-\s+None\b/i.test(item)) {
      sawNone = true;
      continue;
    }

    const link = /\]\(([^)#]+\.md)(?:#[^)]+)?\)/.exec(item)?.[1];
    if (!link) {
      throw new Error(
        `Invalid blocker entry in ${toRepoPath(repoRoot, path)}: ${item}`,
      );
    }
    sawBlocker = true;
    blockerPaths.push(resolve(dirname(path), decodeURIComponent(link)));
  }
  if (!sawNone && !sawBlocker) {
    throw new Error(
      `${toRepoPath(repoRoot, path)} must declare either None or at least one blocker`,
    );
  }
  if (sawNone && sawBlocker) {
    throw new Error(
      `${toRepoPath(repoRoot, path)} cannot declare None together with blockers`,
    );
  }

  const parentSection = sectionLines(body, "Parent") ?? [];
  const parentLink = parentSection
    .map((line) => /\]\(([^)#]+\.md)(?:#[^)]+)?\)/.exec(line)?.[1])
    .find((value): value is string => Boolean(value));
  const parentPath = parentLink
    ? resolve(dirname(path), decodeURIComponent(parentLink))
    : join(repoRoot, ".scratch", feature, "PRD.md");
  const featureRoot = resolve(repoRoot, ".scratch", feature);
  const parentRelative = relative(featureRoot, parentPath);
  if (
    parentRelative === ".." ||
    parentRelative.startsWith(`..${sep}`) ||
    isAbsolute(parentRelative)
  ) {
    throw new Error(
      `Parent PRD for ${toRepoPath(repoRoot, path)} escapes ${toRepoPath(repoRoot, featureRoot)}`,
    );
  }

  return {
    id: `${feature}/${number}`,
    feature,
    number: number!,
    slug: slug!,
    title,
    status,
    path,
    relativePath: toRepoPath(repoRoot, path),
    parentPath,
    blockerPaths,
    body,
  };
};

const completedStatuses = new Set(["done", "integrated", "completed"]);

const assertAcyclic = (tickets: Ticket[], byId: Map<string, Ticket>) => {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (active.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      throw new Error(`Ticket dependency cycle: ${cycle.join(" -> ")}`);
    }

    active.add(id);
    stack.push(id);
    const dependencies = [...(byId.get(id)?.blockedBy ?? [])].sort();
    for (const dependency of dependencies) visit(dependency);
    stack.pop();
    active.delete(id);
    visited.add(id);
  };

  for (const ticket of [...tickets].sort((a, b) => a.id.localeCompare(b.id))) {
    visit(ticket.id);
  }
};

export const loadTicketGraph = async (
  repoRoot: string,
  feature: string,
): Promise<TicketGraph> => {
  assertFeatureSlug(feature);
  const canonicalRepoRoot = await realpath(repoRoot);
  const featureRoot = join(canonicalRepoRoot, ".scratch", feature);
  const canonicalFeatureRoot = await realpath(featureRoot);
  if (canonicalFeatureRoot !== featureRoot) {
    throw new Error(`Feature directory must not be a symlink: ${featureRoot}`);
  }
  const issuesDir = join(featureRoot, "issues");
  const canonicalIssuesDir = await realpath(issuesDir);
  if (canonicalIssuesDir !== issuesDir) {
    throw new Error(`Issues directory must not be a symlink: ${issuesDir}`);
  }

  const entries = await readdir(issuesDir, { withFileTypes: true });
  const parsed: ParsedTicket[] = [];
  for (const entry of entries
    .filter((candidate) => candidate.isFile() && candidate.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(issuesDir, entry.name);
    const canonicalPath = await realpath(path);
    if (canonicalPath !== path) {
      throw new Error(`Ticket file must not be a symlink: ${path}`);
    }
    parsed.push(
      parseTicket(
        canonicalRepoRoot,
        feature,
        path,
        entry.name,
        await readFile(path, "utf8"),
      ),
    );
  }

  for (const ticket of parsed) {
    const canonicalParent = await realpath(ticket.parentPath);
    if (
      canonicalParent !== ticket.parentPath ||
      !canonicalParent.startsWith(`${canonicalFeatureRoot}${sep}`)
    ) {
      throw new Error(`Parent PRD must be a real file inside ${featureRoot}`);
    }
  }

  const parsedByPath = new Map(parsed.map((ticket) => [ticket.path, ticket]));
  const byId = new Map<string, Ticket>();
  const tickets: Ticket[] = [];
  for (const ticket of parsed) {
    const blockedBy: string[] = [];
    for (const blockerPath of ticket.blockerPaths) {
      let canonicalBlocker: string;
      try {
        canonicalBlocker = await realpath(blockerPath);
      } catch {
        canonicalBlocker = blockerPath;
      }
      const blocker = parsedByPath.get(canonicalBlocker);
      if (!blocker || canonicalBlocker !== blockerPath) {
        throw new Error(
          `${ticket.id} references unknown blocker ${toRepoPath(canonicalRepoRoot, blockerPath)}`,
        );
      }
      blockedBy.push(blocker.id);
    }
    const { blockerPaths: _blockerPaths, ...resolvedTicket } = ticket;
    void _blockerPaths;
    tickets.push({
      ...resolvedTicket,
      blockedBy: [...new Set(blockedBy)].sort(),
    });
  }

  for (const ticket of tickets) {
    if (byId.has(ticket.id)) throw new Error(`Duplicate ticket id: ${ticket.id}`);
    byId.set(ticket.id, ticket);
  }

  assertAcyclic(tickets, byId);
  for (const ticket of tickets) {
    if (!completedStatuses.has(ticket.status.toLowerCase())) continue;
    for (const blockerId of ticket.blockedBy) {
      const blocker = byId.get(blockerId)!;
      if (!completedStatuses.has(blocker.status.toLowerCase())) {
        throw new Error(
          `${ticket.id} is ${ticket.status} while blocker ${blocker.id} is ${blocker.status}`,
        );
      }
    }
  }
  return { tickets, byId };
};
