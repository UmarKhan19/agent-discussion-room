export interface TicketBranchResult {
  ticketId: string;
  branch: string;
  baseSha: string;
  headSha: string;
  changedFiles: string[];
}

export interface ConflictIntegrationPlan {
  direct: TicketBranchResult[];
  rerunSequentially: TicketBranchResult[];
}

const normalizeFiles = (files: string[]) =>
  new Set(files.map((file) => file.replaceAll("\\", "/")));

const overlaps = (left: Set<string>, right: Set<string>) => {
  for (const file of left) if (right.has(file)) return true;
  return false;
};

export const planConflictFreeIntegration = (
  results: TicketBranchResult[],
): ConflictIntegrationPlan => {
  const direct: TicketBranchResult[] = [];
  const rerunSequentially: TicketBranchResult[] = [];
  const acceptedFiles: Set<string>[] = [];

  for (const result of [...results].sort((a, b) =>
    a.ticketId.localeCompare(b.ticketId),
  )) {
    const files = normalizeFiles(result.changedFiles);
    if (acceptedFiles.some((accepted) => overlaps(accepted, files))) {
      rerunSequentially.push(result);
      continue;
    }
    direct.push(result);
    acceptedFiles.push(files);
  }

  return { direct, rerunSequentially };
};
