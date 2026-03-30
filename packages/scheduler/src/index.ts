import {
  type Assignment,
  type Character,
  daySortKeyFromWeekStart,
  type GenerateScheduleInput,
  type PartySize,
  type PlayerDeadtimeSummary,
  type RaidInstance,
  type RaidSchedule,
  type Role,
  type ScheduledRaid,
  type ScheduleResult,
  roleCaps
} from "@las/shared";

type PlayerRaidSlot = {
  raidId: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
};

type TimeSlot = {
  dayOfWeek: number;
  startMinute: number;
};

const SLOT_STEP_MINUTES = 20;
const MAX_RAIDS_PER_CHARACTER = 3;
const SOFT_MAX_RAIDS_PER_DAY = 8;
const SOFT_MAX_SAME_RAID_STREAK = 2;
const SOFT_DEADTIME_MAX_GAP_TOLERANCE_MINUTES = 20;
const SOFT_DEADTIME_TOTAL_GAP_TOLERANCE_MINUTES = 40;

const RAID_PARTY_SIZE_RULES: Array<{ match: RegExp; capacity: PartySize }> = [
  { match: /kayangel|ivory|voldis/i, capacity: 4 }
];

function partySizeForRaid(raid: RaidInstance): PartySize {
  for (const rule of RAID_PARTY_SIZE_RULES) {
    if (rule.match.test(raid.name)) {
      return rule.capacity;
    }
  }
  return 8;
}

function normalizeRaidName(name: string): string {
  return name.trim().toLowerCase();
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function canTakeRole(characterRole: Role, neededRole: "DPS" | "Support"): boolean {
  if (characterRole === "DPS/Support") {
    return true;
  }
  return characterRole === neededRole;
}

function hasRaidConflict(playerSlots: PlayerRaidSlot[], raid: ScheduledRaid): boolean {
  const raidEnd = raid.startMinute + raid.durationMinutes;
  return playerSlots.some((slot) => {
    if (slot.dayOfWeek !== raid.dayOfWeek) {
      return false;
    }
    return overlaps(slot.startMinute, slot.endMinute, raid.startMinute, raidEnd);
  });
}

function contiguityScore(playerSlots: PlayerRaidSlot[], raid: ScheduledRaid): number {
  if (playerSlots.length === 0) {
    return 1000;
  }

  const raidEnd = raid.startMinute + raid.durationMinutes;
  let bestGap = Number.MAX_SAFE_INTEGER;

  for (const slot of playerSlots) {
    if (slot.dayOfWeek !== raid.dayOfWeek) {
      continue;
    }

    const gapBefore = Math.abs(slot.endMinute - raid.startMinute);
    const gapAfter = Math.abs(slot.startMinute - raidEnd);
    bestGap = Math.min(bestGap, gapBefore, gapAfter);
  }

  if (bestGap === Number.MAX_SAFE_INTEGER) {
    return 500;
  }

  return 500 - bestGap;
}

function summarizeDeadtime(
  assignmentsByPlayer: Map<string, PlayerRaidSlot[]>
): PlayerDeadtimeSummary[] {
  const summaries: PlayerDeadtimeSummary[] = [];

  for (const [playerId, slots] of assignmentsByPlayer.entries()) {
    const sorted = [...slots].sort((a, b) => {
      if (a.dayOfWeek !== b.dayOfWeek) {
        return a.dayOfWeek - b.dayOfWeek;
      }
      return a.startMinute - b.startMinute;
    });

    let totalGapMinutes = 0;
    let largestGapMinutes = 0;

    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (cur.dayOfWeek !== prev.dayOfWeek) {
        continue;
      }

      const gap = Math.max(0, cur.startMinute - prev.endMinute);
      totalGapMinutes += gap;
      largestGapMinutes = Math.max(largestGapMinutes, gap);
    }

    summaries.push({
      playerId,
      totalGapMinutes,
      largestGapMinutes,
      assignmentCount: sorted.length
    });
  }

  return summaries.sort((a, b) => a.playerId.localeCompare(b.playerId));
}

function summarizeSinglePlayerIntraDayDeadtime(slots: PlayerRaidSlot[]): { totalGapMinutes: number; largestGapMinutes: number } {
  if (slots.length <= 1) {
    return { totalGapMinutes: 0, largestGapMinutes: 0 };
  }

  const sorted = [...slots].sort((a, b) => {
    if (a.dayOfWeek !== b.dayOfWeek) {
      return a.dayOfWeek - b.dayOfWeek;
    }
    return a.startMinute - b.startMinute;
  });

  let totalGapMinutes = 0;
  let largestGapMinutes = 0;

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.dayOfWeek !== prev.dayOfWeek) {
      continue;
    }

    const gap = Math.max(0, cur.startMinute - prev.endMinute);
    totalGapMinutes += gap;
    largestGapMinutes = Math.max(largestGapMinutes, gap);
  }

  return { totalGapMinutes, largestGapMinutes };
}

function projectAssignments(
  assignmentsByPlayer: Map<string, PlayerRaidSlot[]>,
  raid: ScheduledRaid,
  assignments: Assignment[]
): Map<string, PlayerRaidSlot[]> {
  const projected = new Map<string, PlayerRaidSlot[]>();
  for (const [playerId, slots] of assignmentsByPlayer.entries()) {
    projected.set(playerId, [...slots]);
  }

  for (const assignment of assignments) {
    const slotList = projected.get(assignment.playerId) ?? [];
    slotList.push({
      raidId: raid.id,
      dayOfWeek: raid.dayOfWeek,
      startMinute: raid.startMinute,
      endMinute: raid.startMinute + raid.durationMinutes
    });
    projected.set(assignment.playerId, slotList);
  }

  return projected;
}

function deadtimeObjective(assignmentsByPlayer: Map<string, PlayerRaidSlot[]>): { maxGapMinutes: number; totalGapMinutes: number } {
  let maxGapMinutes = 0;
  let totalGapMinutes = 0;

  for (const slots of assignmentsByPlayer.values()) {
    const summary = summarizeSinglePlayerIntraDayDeadtime(slots);
    maxGapMinutes = Math.max(maxGapMinutes, summary.largestGapMinutes);
    totalGapMinutes += summary.totalGapMinutes;
  }

  return { maxGapMinutes, totalGapMinutes };
}

function softScheduleObjective(
  existingRaidSchedules: RaidSchedule[],
  candidateRaid: ScheduledRaid
): { dayOverflow: number; streakExcess: number } {
  const dayRaids = existingRaidSchedules
    .map((entry) => entry.raid)
    .filter((raid) => raid.dayOfWeek === candidateRaid.dayOfWeek);

  const dayOverflow = Math.max(0, dayRaids.length + 1 - SOFT_MAX_RAIDS_PER_DAY);

  const sortedDayRaids = [...dayRaids, candidateRaid].sort((a, b) => {
    if (a.startMinute !== b.startMinute) {
      return a.startMinute - b.startMinute;
    }
    return a.id.localeCompare(b.id);
  });

  let streakExcess = 0;
  let streak = 0;
  let lastRaidName = "";

  for (const raid of sortedDayRaids) {
    const raidName = normalizeRaidName(raid.name);
    if (raidName === lastRaidName) {
      streak += 1;
    } else {
      lastRaidName = raidName;
      streak = 1;
    }

    if (streak > SOFT_MAX_SAME_RAID_STREAK) {
      streakExcess += streak - SOFT_MAX_SAME_RAID_STREAK;
    }
  }

  return { dayOverflow, streakExcess };
}

function isSoftObjectiveBetter(
  candidate: { dayOverflow: number; streakExcess: number },
  baseline: { dayOverflow: number; streakExcess: number }
): boolean {
  if (candidate.dayOverflow !== baseline.dayOverflow) {
    return candidate.dayOverflow < baseline.dayOverflow;
  }
  if (candidate.streakExcess !== baseline.streakExcess) {
    return candidate.streakExcess < baseline.streakExcess;
  }
  return false;
}

function isDeadtimeAcceptableForSoft(
  candidate: { maxGapMinutes: number; totalGapMinutes: number },
  baseline: { maxGapMinutes: number; totalGapMinutes: number }
): boolean {
  return candidate.maxGapMinutes <= baseline.maxGapMinutes + SOFT_DEADTIME_MAX_GAP_TOLERANCE_MINUTES
    && candidate.totalGapMinutes <= baseline.totalGapMinutes + SOFT_DEADTIME_TOTAL_GAP_TOLERANCE_MINUTES;
}

function containsSlot(
  windows: { dayOfWeek: number; startMinute: number; endMinute: number }[],
  slot: TimeSlot,
  durationMinutes: number
): boolean {
  const endMinute = slot.startMinute + durationMinutes;
  return windows.some((w) => w.dayOfWeek === slot.dayOfWeek && w.startMinute <= slot.startMinute && w.endMinute >= endMinute);
}

function buildCandidateSlots(
  raid: RaidInstance,
  availabilityByPlayer: Map<string, { dayOfWeek: number; startMinute: number; endMinute: number }[]>
): TimeSlot[] {
  const seen = new Set<string>();
  const slots: TimeSlot[] = [];

  for (const windows of availabilityByPlayer.values()) {
    for (const window of windows) {
      const latestStart = window.endMinute - raid.durationMinutes;
      if (latestStart < window.startMinute) {
        continue;
      }

      for (let startMinute = window.startMinute; startMinute <= latestStart; startMinute += SLOT_STEP_MINUTES) {
        const key = `${window.dayOfWeek}-${startMinute}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        slots.push({ dayOfWeek: window.dayOfWeek, startMinute });
      }
    }
  }

  slots.sort((a, b) => {
    const daySort = daySortKeyFromWeekStart(a.dayOfWeek, 3) - daySortKeyFromWeekStart(b.dayOfWeek, 3);
    if (daySort !== 0) {
      return daySort;
    }
    return a.startMinute - b.startMinute;
  });

  return slots;
}

function evaluateSlot(
  raid: RaidInstance,
  slot: TimeSlot,
  characters: Character[],
  adminPlayerId: string | undefined,
  availabilityByPlayer: Map<string, { dayOfWeek: number; startMinute: number; endMinute: number }[]>,
  assignmentsByPlayer: Map<string, PlayerRaidSlot[]>,
  assignedRaidsByCharacter: Map<string, number>,
  allowedRaidIdsByCharacter: Map<string, Set<string>>,
  assignedRaidNamesByCharacter: Map<string, Set<string>>
): { scheduledRaid: ScheduledRaid; assignments: Assignment[] } {
  const capacity = partySizeForRaid(raid);
  const scheduledRaid: ScheduledRaid = {
    ...raid,
    capacity,
    dayOfWeek: slot.dayOfWeek,
    startMinute: slot.startMinute
  };

  const caps = roleCaps(capacity);

  const candidates = characters.filter((c) => {
    const allowedRaidIds = allowedRaidIdsByCharacter.get(c.id);
    if (!allowedRaidIds || !allowedRaidIds.has(raid.id)) {
      return false;
    }

    const assignedCount = assignedRaidsByCharacter.get(c.id) ?? 0;
    if (assignedCount >= MAX_RAIDS_PER_CHARACTER) {
      return false;
    }

    const alreadyAssignedRaidNames = assignedRaidNamesByCharacter.get(c.id) ?? new Set<string>();
    if (alreadyAssignedRaidNames.has(normalizeRaidName(raid.name))) {
      return false;
    }

    if (c.itemLevel < raid.itemLevelRequirement) {
      return false;
    }

    const windows = availabilityByPlayer.get(c.playerId) ?? [];
    if (!containsSlot(windows, slot, raid.durationMinutes)) {
      return false;
    }

    const existingSlots = assignmentsByPlayer.get(c.playerId) ?? [];
    if (hasRaidConflict(existingSlots, scheduledRaid)) {
      return false;
    }

    return true;
  });

  const sortedCandidates = [...candidates].sort((a, b) => {
    const aSlots = assignmentsByPlayer.get(a.playerId) ?? [];
    const bSlots = assignmentsByPlayer.get(b.playerId) ?? [];

    const raidEnd = scheduledRaid.startMinute + scheduledRaid.durationMinutes;
    const aProjected = summarizeSinglePlayerIntraDayDeadtime([
      ...aSlots,
      {
        raidId: raid.id,
        dayOfWeek: scheduledRaid.dayOfWeek,
        startMinute: scheduledRaid.startMinute,
        endMinute: raidEnd
      }
    ]);
    const bProjected = summarizeSinglePlayerIntraDayDeadtime([
      ...bSlots,
      {
        raidId: raid.id,
        dayOfWeek: scheduledRaid.dayOfWeek,
        startMinute: scheduledRaid.startMinute,
        endMinute: raidEnd
      }
    ]);

    if (aProjected.largestGapMinutes !== bProjected.largestGapMinutes) {
      return aProjected.largestGapMinutes - bProjected.largestGapMinutes;
    }

    if (aProjected.totalGapMinutes !== bProjected.totalGapMinutes) {
      return aProjected.totalGapMinutes - bProjected.totalGapMinutes;
    }

    const scoreDiff = contiguityScore(bSlots, scheduledRaid) - contiguityScore(aSlots, scheduledRaid);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    if (a.itemLevel !== b.itemLevel) {
      return a.itemLevel - b.itemLevel;
    }
    return a.id.localeCompare(b.id);
  });

  const tryAssign = (
    neededRole: "DPS" | "Support",
    usedCharacterIdsForAttempt: Set<string>,
    usedPlayerIdsForAttempt: Set<string>,
    raidAssignmentsForAttempt: Assignment[]
  ) => {
    for (const character of sortedCandidates) {
      if (usedCharacterIdsForAttempt.has(character.id)) {
        continue;
      }
      if (usedPlayerIdsForAttempt.has(character.playerId)) {
        continue;
      }
      if (!canTakeRole(character.role, neededRole)) {
        continue;
      }

      usedCharacterIdsForAttempt.add(character.id);
      usedPlayerIdsForAttempt.add(character.playerId);
      raidAssignmentsForAttempt.push({
        raidId: raid.id,
        characterId: character.id,
        playerId: character.playerId,
        assignedRole: neededRole
      });
      return true;
    }
    return false;
  };

  const evaluateWithSeed = (seedCharacter?: Character, seedRole?: "DPS" | "Support") => {
    const seededAssignments: Assignment[] = [];
    const seededUsedCharacterIds = new Set<string>();
    const seededUsedPlayerIds = new Set<string>();
    const candidateById = new Map(sortedCandidates.map((c) => [c.id, c]));
    let seededSupportCount = 0;
    let seededDpsCount = 0;

    if (seedCharacter && seedRole) {
      seededUsedCharacterIds.add(seedCharacter.id);
      seededUsedPlayerIds.add(seedCharacter.playerId);
      seededAssignments.push({
        raidId: raid.id,
        characterId: seedCharacter.id,
        playerId: seedCharacter.playerId,
        assignedRole: seedRole
      });
      if (seedRole === "Support") {
        seededSupportCount += 1;
      } else {
        seededDpsCount += 1;
      }
    }

    while (seededSupportCount < caps.maxSupport && seededAssignments.length < capacity) {
      const assigned = tryAssign("Support", seededUsedCharacterIds, seededUsedPlayerIds, seededAssignments);
      if (!assigned) {
        break;
      }
      seededSupportCount += 1;
    }

    while (seededDpsCount < caps.maxDps && seededAssignments.length < capacity) {
      const assigned = tryAssign("DPS", seededUsedCharacterIds, seededUsedPlayerIds, seededAssignments);
      if (!assigned) {
        break;
      }
      seededDpsCount += 1;
    }

    // If support slots remain open, prefer converting flex DPS to support.
    while (seededSupportCount < caps.maxSupport) {
      const flexDpsAssignment = seededAssignments.find((assignment) => {
        if (assignment.assignedRole !== "DPS") {
          return false;
        }
        const character = candidateById.get(assignment.characterId);
        return character?.role === "DPS/Support";
      });

      if (!flexDpsAssignment) {
        break;
      }

      flexDpsAssignment.assignedRole = "Support";
      seededSupportCount += 1;
      seededDpsCount = Math.max(0, seededDpsCount - 1);

      // After promoting flex to support, try to refill DPS from unused candidates.
      while (seededDpsCount < caps.maxDps && seededAssignments.length < capacity) {
        const assigned = tryAssign("DPS", seededUsedCharacterIds, seededUsedPlayerIds, seededAssignments);
        if (!assigned) {
          break;
        }
        seededDpsCount += 1;
      }
    }

    return seededAssignments;
  };

  if (adminPlayerId) {
    const adminCandidates = sortedCandidates.filter((c) => c.playerId === adminPlayerId);
    if (adminCandidates.length === 0) {
      return { scheduledRaid, assignments: [] };
    }

    let bestSeededAssignments: Assignment[] = [];

    for (const adminCandidate of adminCandidates) {
      const seedRoles: Array<"DPS" | "Support"> = [];
      if (canTakeRole(adminCandidate.role, "Support") && caps.maxSupport > 0) {
        seedRoles.push("Support");
      }
      if (canTakeRole(adminCandidate.role, "DPS") && caps.maxDps > 0) {
        seedRoles.push("DPS");
      }

      for (const seedRole of seedRoles) {
        const seeded = evaluateWithSeed(adminCandidate, seedRole);
        if (seeded.length > bestSeededAssignments.length) {
          bestSeededAssignments = seeded;
        }
      }
    }

    return { scheduledRaid, assignments: bestSeededAssignments };
  }

  return { scheduledRaid, assignments: evaluateWithSeed() };
}

export function generateWeeklySchedule(input: GenerateScheduleInput): ScheduleResult {
  const adminPlayerId = input.players[0]?.id;
  const availabilityByPlayer = new Map<string, { dayOfWeek: number; startMinute: number; endMinute: number }[]>();
  for (const window of input.availabilityWindows) {
    const list = availabilityByPlayer.get(window.playerId) ?? [];
    list.push(window);
    availabilityByPlayer.set(window.playerId, list);
  }

  const characters = [...input.characters];
  const raids = [...input.raids].sort((a, b) => {
    if (b.itemLevelRequirement !== a.itemLevelRequirement) {
      return b.itemLevelRequirement - a.itemLevelRequirement;
    }
    if (b.durationMinutes !== a.durationMinutes) {
      return b.durationMinutes - a.durationMinutes;
    }
    return a.id.localeCompare(b.id);
  });

  const assignmentsByPlayer = new Map<string, PlayerRaidSlot[]>();
  const assignedRaidsByCharacter = new Map<string, number>();
  const assignedRaidNamesByCharacter = new Map<string, Set<string>>();
  const allowedRaidIdsByCharacter = new Map<string, Set<string>>();

  const raidPriorityOrder = [...raids].sort((a, b) => {
    if (b.itemLevelRequirement !== a.itemLevelRequirement) {
      return b.itemLevelRequirement - a.itemLevelRequirement;
    }
    return a.id.localeCompare(b.id);
  });

  for (const character of characters) {
    const eligibleUniqueRaids: RaidInstance[] = [];
    const seenRaidNames = new Set<string>();

    for (const raid of raidPriorityOrder) {
      if (character.itemLevel < raid.itemLevelRequirement) {
        continue;
      }

      const raidNameKey = normalizeRaidName(raid.name);
      if (seenRaidNames.has(raidNameKey)) {
        continue;
      }

      seenRaidNames.add(raidNameKey);
      eligibleUniqueRaids.push(raid);

      if (eligibleUniqueRaids.length >= MAX_RAIDS_PER_CHARACTER) {
        break;
      }
    }

    const optedOutRaidIds = new Set(character.raidOptOutRaidIds ?? []);
    const eligibleTopRaids = eligibleUniqueRaids
      .filter((raid) => !optedOutRaidIds.has(raid.id))
      .map((raid) => raid.id);
    allowedRaidIdsByCharacter.set(character.id, new Set(eligibleTopRaids));
  }

  const raidSchedules: RaidSchedule[] = [];
  const candidateSlotsByRaid = new Map<string, TimeSlot[]>();
  for (const raid of raids) {
    candidateSlotsByRaid.set(raid.id, buildCandidateSlots(raid, availabilityByPlayer));
  }

  while (true) {
    let bestRaidTemplate: RaidInstance | null = null;
    let bestEvaluation: { scheduledRaid: ScheduledRaid; assignments: Assignment[] } | null = null;

    for (const raid of raids) {
      const candidateSlots = candidateSlotsByRaid.get(raid.id) ?? [];
      if (candidateSlots.length === 0) {
        continue;
      }

      let bestForRaid: { scheduledRaid: ScheduledRaid; assignments: Assignment[] } | null = null;

      for (const slot of candidateSlots) {
        const evaluation = evaluateSlot(
          raid,
          slot,
          characters,
          adminPlayerId,
          availabilityByPlayer,
          assignmentsByPlayer,
          assignedRaidsByCharacter,
          allowedRaidIdsByCharacter,
          assignedRaidNamesByCharacter
        );

        if (!bestForRaid || evaluation.assignments.length > bestForRaid.assignments.length) {
          bestForRaid = evaluation;
          continue;
        }

        if (bestForRaid && evaluation.assignments.length === bestForRaid.assignments.length) {
          const evalProjected = projectAssignments(assignmentsByPlayer, evaluation.scheduledRaid, evaluation.assignments);
          const bestProjected = projectAssignments(assignmentsByPlayer, bestForRaid.scheduledRaid, bestForRaid.assignments);
          const evalDeadtime = deadtimeObjective(evalProjected);
          const bestDeadtime = deadtimeObjective(bestProjected);
          const evalSoft = softScheduleObjective(raidSchedules, evaluation.scheduledRaid);
          const bestSoft = softScheduleObjective(raidSchedules, bestForRaid.scheduledRaid);
          const softImproves = isSoftObjectiveBetter(evalSoft, bestSoft);

          if (evalDeadtime.maxGapMinutes < bestDeadtime.maxGapMinutes) {
            bestForRaid = evaluation;
            continue;
          }

          if (
            evalDeadtime.maxGapMinutes > bestDeadtime.maxGapMinutes
            && !(softImproves && isDeadtimeAcceptableForSoft(evalDeadtime, bestDeadtime))
          ) {
            continue;
          }

          if (softImproves && isDeadtimeAcceptableForSoft(evalDeadtime, bestDeadtime)) {
            bestForRaid = evaluation;
            continue;
          }

          if (
            evalDeadtime.maxGapMinutes === bestDeadtime.maxGapMinutes
            && evalDeadtime.totalGapMinutes < bestDeadtime.totalGapMinutes
          ) {
            bestForRaid = evaluation;
            continue;
          }

          const evalDay = daySortKeyFromWeekStart(evaluation.scheduledRaid.dayOfWeek, 3);
          const bestDay = daySortKeyFromWeekStart(bestForRaid.scheduledRaid.dayOfWeek, 3);
          if (evalDay < bestDay || (evalDay === bestDay && evaluation.scheduledRaid.startMinute < bestForRaid.scheduledRaid.startMinute)) {
            bestForRaid = evaluation;
          }
        }
      }

      if (!bestForRaid || bestForRaid.assignments.length === 0) {
        continue;
      }

      if (!bestEvaluation || !bestRaidTemplate) {
        bestRaidTemplate = raid;
        bestEvaluation = bestForRaid;
        continue;
      }

      if (bestForRaid.assignments.length > bestEvaluation.assignments.length) {
        bestRaidTemplate = raid;
        bestEvaluation = bestForRaid;
        continue;
      }

      if (bestForRaid.assignments.length === bestEvaluation.assignments.length) {
        const evalProjected = projectAssignments(assignmentsByPlayer, bestForRaid.scheduledRaid, bestForRaid.assignments);
        const bestProjected = projectAssignments(assignmentsByPlayer, bestEvaluation.scheduledRaid, bestEvaluation.assignments);
        const evalDeadtime = deadtimeObjective(evalProjected);
        const bestDeadtime = deadtimeObjective(bestProjected);
        const evalSoft = softScheduleObjective(raidSchedules, bestForRaid.scheduledRaid);
        const bestSoft = softScheduleObjective(raidSchedules, bestEvaluation.scheduledRaid);
        const softImproves = isSoftObjectiveBetter(evalSoft, bestSoft);

        if (evalDeadtime.maxGapMinutes < bestDeadtime.maxGapMinutes) {
          bestRaidTemplate = raid;
          bestEvaluation = bestForRaid;
          continue;
        }

        if (
          evalDeadtime.maxGapMinutes > bestDeadtime.maxGapMinutes
          && !(softImproves && isDeadtimeAcceptableForSoft(evalDeadtime, bestDeadtime))
        ) {
          continue;
        }

        if (softImproves && isDeadtimeAcceptableForSoft(evalDeadtime, bestDeadtime)) {
          bestRaidTemplate = raid;
          bestEvaluation = bestForRaid;
          continue;
        }

        if (
          evalDeadtime.maxGapMinutes === bestDeadtime.maxGapMinutes
          && evalDeadtime.totalGapMinutes < bestDeadtime.totalGapMinutes
        ) {
          bestRaidTemplate = raid;
          bestEvaluation = bestForRaid;
          continue;
        }

        if (raid.itemLevelRequirement > bestRaidTemplate.itemLevelRequirement) {
          bestRaidTemplate = raid;
          bestEvaluation = bestForRaid;
          continue;
        }

        if (raid.itemLevelRequirement === bestRaidTemplate.itemLevelRequirement) {
          const evalDay = daySortKeyFromWeekStart(bestForRaid.scheduledRaid.dayOfWeek, 3);
          const bestDay = daySortKeyFromWeekStart(bestEvaluation.scheduledRaid.dayOfWeek, 3);
          if (evalDay < bestDay || (evalDay === bestDay && bestForRaid.scheduledRaid.startMinute < bestEvaluation.scheduledRaid.startMinute)) {
            bestRaidTemplate = raid;
            bestEvaluation = bestForRaid;
          }
        }
      }
    }

    if (!bestEvaluation || !bestRaidTemplate) {
      break;
    }

    const scheduledRaid = bestEvaluation.scheduledRaid;
    const raidAssignments = bestEvaluation.assignments;

    for (const assignment of raidAssignments) {
      const currentCharacterCount = assignedRaidsByCharacter.get(assignment.characterId) ?? 0;
      assignedRaidsByCharacter.set(assignment.characterId, currentCharacterCount + 1);

      const assignedRaidNames = assignedRaidNamesByCharacter.get(assignment.characterId) ?? new Set<string>();
      assignedRaidNames.add(normalizeRaidName(scheduledRaid.name));
      assignedRaidNamesByCharacter.set(assignment.characterId, assignedRaidNames);

      const slotList = assignmentsByPlayer.get(assignment.playerId) ?? [];
      slotList.push({
        raidId: scheduledRaid.id,
        dayOfWeek: scheduledRaid.dayOfWeek,
        startMinute: scheduledRaid.startMinute,
        endMinute: scheduledRaid.startMinute + scheduledRaid.durationMinutes
      });
      assignmentsByPlayer.set(assignment.playerId, slotList);
    }

    const warnings: string[] = [];
    if (raidAssignments.length < scheduledRaid.capacity) {
      warnings.push(
        `Raid underfilled: assigned ${raidAssignments.length}/${scheduledRaid.capacity}. Up to 2 slots remain reserved for supports.`
      );
    }

    raidSchedules.push({
      raid: scheduledRaid,
      assignments: raidAssignments,
      isFull: raidAssignments.length === scheduledRaid.capacity,
      warnings
    });
  }

  raidSchedules.sort((a, b) => {
    const daySort = daySortKeyFromWeekStart(a.raid.dayOfWeek, 3) - daySortKeyFromWeekStart(b.raid.dayOfWeek, 3);
    if (daySort !== 0) {
      return daySort;
    }
    if (a.raid.startMinute !== b.raid.startMinute) {
      return a.raid.startMinute - b.raid.startMinute;
    }
    return a.raid.id.localeCompare(b.raid.id);
  });

  const unassignedRaidIds = [...new Set(raidSchedules.filter((r) => !r.isFull).map((r) => r.raid.id))];
  const playerDeadtime = summarizeDeadtime(assignmentsByPlayer);

  return {
    raidSchedules,
    unassignedRaidIds,
    playerDeadtime
  };
}
