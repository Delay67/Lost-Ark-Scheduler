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
  vipPriorityCharacterIds: Set<string>,
  requiredCharacterIdsByPlayerRaid: Map<string, Set<string>>,
  characterIdsByPlayer: Map<string, string[]>,
  availabilityByPlayer: Map<string, { dayOfWeek: number; startMinute: number; endMinute: number }[]>,
  assignmentsByPlayer: Map<string, PlayerRaidSlot[]>,
  assignedRaidsByCharacter: Map<string, number>,
  assignedRaidIdsByCharacter: Map<string, Set<string>>,
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
    const aVipPriority = vipPriorityCharacterIds.has(a.id) ? 1 : 0;
    const bVipPriority = vipPriorityCharacterIds.has(b.id) ? 1 : 0;
    if (aVipPriority !== bVipPriority) {
      return bVipPriority - aVipPriority;
    }

    const deficitForPlayer = (playerId: string): number => {
      const requiredCharIds = requiredCharacterIdsByPlayerRaid.get(`${playerId}|${raid.id}`) ?? new Set<string>();
      if (requiredCharIds.size === 0) {
        return 0;
      }

      let assignedForRaid = 0;
      const playerCharIds = characterIdsByPlayer.get(playerId) ?? [];
      for (const charId of playerCharIds) {
        const assignedRaidIds = assignedRaidIdsByCharacter.get(charId);
        if (assignedRaidIds?.has(raid.id)) {
          assignedForRaid += 1;
        }
      }

      return requiredCharIds.size - assignedForRaid;
    };

    const aDeficit = deficitForPlayer(a.playerId);
    const bDeficit = deficitForPlayer(b.playerId);
    if (aDeficit !== bDeficit) {
      return bDeficit - aDeficit;
    }

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

  const vipProgressCount = (assignments: Assignment[]): number => (
    assignments.filter((a) => vipPriorityCharacterIds.has(a.characterId)).length
  );

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
          continue;
        }

        if (seeded.length === bestSeededAssignments.length && vipProgressCount(seeded) > vipProgressCount(bestSeededAssignments)) {
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
  const vipPlayerIds = new Set(input.players.filter((p) => p.vip).map((p) => p.id));
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
  const assignedRaidIdsByCharacter = new Map<string, Set<string>>();
  const allowedRaidIdsByCharacter = new Map<string, Set<string>>();
  const requiredRaidIdsByVipCharacter = new Map<string, Set<string>>();
  const requiredCharacterIdsByPlayerRaid = new Map<string, Set<string>>();
  const characterIdsByPlayer = new Map<string, string[]>();

  const raidPriorityOrder = [...raids].sort((a, b) => {
    if (b.itemLevelRequirement !== a.itemLevelRequirement) {
      return b.itemLevelRequirement - a.itemLevelRequirement;
    }
    return a.id.localeCompare(b.id);
  });

  for (const character of characters) {
    const playerCharIds = characterIdsByPlayer.get(character.playerId) ?? [];
    playerCharIds.push(character.id);
    characterIdsByPlayer.set(character.playerId, playerCharIds);

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

    for (const raidId of eligibleTopRaids) {
      const key = `${character.playerId}|${raidId}`;
      const setForKey = requiredCharacterIdsByPlayerRaid.get(key) ?? new Set<string>();
      setForKey.add(character.id);
      requiredCharacterIdsByPlayerRaid.set(key, setForKey);
    }

    if (vipPlayerIds.has(character.playerId)) {
      requiredRaidIdsByVipCharacter.set(character.id, new Set(eligibleTopRaids));
    }
  }

  const raidSchedules: RaidSchedule[] = [];
  const candidateSlotsByRaid = new Map<string, TimeSlot[]>();
  for (const raid of raids) {
    candidateSlotsByRaid.set(raid.id, buildCandidateSlots(raid, availabilityByPlayer));
  }

  while (true) {
    const vipPriorityCharacterIds = new Set<string>();
    for (const [characterId, requiredRaidIds] of requiredRaidIdsByVipCharacter.entries()) {
      const assignedIds = assignedRaidIdsByCharacter.get(characterId) ?? new Set<string>();
      for (const raidId of requiredRaidIds) {
        if (!assignedIds.has(raidId)) {
          vipPriorityCharacterIds.add(characterId);
          break;
        }
      }
    }
    const hasUnmetVipRequirements = vipPriorityCharacterIds.size > 0;

    let bestRaidTemplate: RaidInstance | null = null;
    let bestEvaluation: { scheduledRaid: ScheduledRaid; assignments: Assignment[] } | null = null;

    for (const raid of raids) {
      const candidateSlots = candidateSlotsByRaid.get(raid.id) ?? [];
      if (candidateSlots.length === 0) {
        continue;
      }

      let bestForRaid: { scheduledRaid: ScheduledRaid; assignments: Assignment[] } | null = null;

      for (const slot of candidateSlots) {
        const vipPriorityForRaid = new Set<string>();
        for (const characterId of vipPriorityCharacterIds) {
          const allowed = allowedRaidIdsByCharacter.get(characterId);
          const assignedIds = assignedRaidIdsByCharacter.get(characterId) ?? new Set<string>();
          if (allowed?.has(raid.id) && !assignedIds.has(raid.id)) {
            vipPriorityForRaid.add(characterId);
          }
        }

        const evaluation = evaluateSlot(
          raid,
          slot,
          characters,
          adminPlayerId,
          vipPriorityForRaid,
          requiredCharacterIdsByPlayerRaid,
          characterIdsByPlayer,
          availabilityByPlayer,
          assignmentsByPlayer,
          assignedRaidsByCharacter,
          assignedRaidIdsByCharacter,
          allowedRaidIdsByCharacter,
          assignedRaidNamesByCharacter
        );

        const evaluationVipProgress = evaluation.assignments.filter((a) => vipPriorityForRaid.has(a.characterId)).length;
        const bestVipProgress = bestForRaid
          ? bestForRaid.assignments.filter((a) => vipPriorityForRaid.has(a.characterId)).length
          : -1;

        if (hasUnmetVipRequirements && evaluationVipProgress > bestVipProgress) {
          bestForRaid = evaluation;
          continue;
        }

        if (hasUnmetVipRequirements && evaluationVipProgress < bestVipProgress) {
          continue;
        }

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

      if (hasUnmetVipRequirements) {
        const progressesVip = bestForRaid.assignments.some((assignment) => vipPriorityCharacterIds.has(assignment.characterId));
        if (!progressesVip) {
          continue;
        }
      }

      if (!bestEvaluation || !bestRaidTemplate) {
        bestRaidTemplate = raid;
        bestEvaluation = bestForRaid;
        continue;
      }

      const bestForRaidVipProgress = bestForRaid.assignments.filter((a) => vipPriorityCharacterIds.has(a.characterId)).length;
      const bestEvalVipProgress = bestEvaluation.assignments.filter((a) => vipPriorityCharacterIds.has(a.characterId)).length;

      if (hasUnmetVipRequirements && bestForRaidVipProgress > bestEvalVipProgress) {
        bestRaidTemplate = raid;
        bestEvaluation = bestForRaid;
        continue;
      }

      if (hasUnmetVipRequirements && bestForRaidVipProgress < bestEvalVipProgress) {
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

      const assignedRaidIds = assignedRaidIdsByCharacter.get(assignment.characterId) ?? new Set<string>();
      assignedRaidIds.add(scheduledRaid.id);
      assignedRaidIdsByCharacter.set(assignment.characterId, assignedRaidIds);

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

  const characterById = new Map(characters.map((c) => [c.id, c]));

  const getRoleCounts = (raidSchedule: RaidSchedule) => {
    let support = 0;
    let dps = 0;
    for (const a of raidSchedule.assignments) {
      if (a.assignedRole === "Support") {
        support += 1;
      } else {
        dps += 1;
      }
    }
    return { support, dps };
  };

  const playerAlreadyInRaid = (raidSchedule: RaidSchedule, playerId: string): boolean => (
    raidSchedule.assignments.some((a) => a.playerId === playerId)
  );

  const removeAssignment = (raidSchedule: RaidSchedule, assignment: Assignment): boolean => {
    const idx = raidSchedule.assignments.findIndex((a) => (
      a.characterId === assignment.characterId
      && a.playerId === assignment.playerId
      && a.raidId === assignment.raidId
      && a.assignedRole === assignment.assignedRole
    ));
    if (idx < 0) {
      return false;
    }

    raidSchedule.assignments.splice(idx, 1);

    const currentCharacterCount = assignedRaidsByCharacter.get(assignment.characterId) ?? 0;
    assignedRaidsByCharacter.set(assignment.characterId, Math.max(0, currentCharacterCount - 1));

    assignedRaidNamesByCharacter.get(assignment.characterId)?.delete(normalizeRaidName(raidSchedule.raid.name));
    assignedRaidIdsByCharacter.get(assignment.characterId)?.delete(raidSchedule.raid.id);

    const playerSlots = assignmentsByPlayer.get(assignment.playerId) ?? [];
    const slotIdx = playerSlots.findIndex((s) => (
      s.raidId === raidSchedule.raid.id
      && s.dayOfWeek === raidSchedule.raid.dayOfWeek
      && s.startMinute === raidSchedule.raid.startMinute
      && s.endMinute === raidSchedule.raid.startMinute + raidSchedule.raid.durationMinutes
    ));
    if (slotIdx >= 0) {
      playerSlots.splice(slotIdx, 1);
      assignmentsByPlayer.set(assignment.playerId, playerSlots);
    }

    return true;
  };

  const addAssignment = (raidSchedule: RaidSchedule, character: Character, role: "DPS" | "Support"): boolean => {
    const allowed = allowedRaidIdsByCharacter.get(character.id);
    if (!allowed?.has(raidSchedule.raid.id)) {
      return false;
    }
    if (character.itemLevel < raidSchedule.raid.itemLevelRequirement) {
      return false;
    }
    if (playerAlreadyInRaid(raidSchedule, character.playerId)) {
      return false;
    }
    const assignedCount = assignedRaidsByCharacter.get(character.id) ?? 0;
    if (assignedCount >= MAX_RAIDS_PER_CHARACTER) {
      return false;
    }
    const assignedNames = assignedRaidNamesByCharacter.get(character.id) ?? new Set<string>();
    if (assignedNames.has(normalizeRaidName(raidSchedule.raid.name))) {
      return false;
    }

    const windows = availabilityByPlayer.get(character.playerId) ?? [];
    if (!containsSlot(windows, { dayOfWeek: raidSchedule.raid.dayOfWeek, startMinute: raidSchedule.raid.startMinute }, raidSchedule.raid.durationMinutes)) {
      return false;
    }

    const existingSlots = assignmentsByPlayer.get(character.playerId) ?? [];
    if (hasRaidConflict(existingSlots, raidSchedule.raid)) {
      return false;
    }

    if (!canTakeRole(character.role, role)) {
      return false;
    }

    const counts = getRoleCounts(raidSchedule);
    const caps = roleCaps(raidSchedule.raid.capacity);
    if (role === "Support" && counts.support >= caps.maxSupport) {
      return false;
    }
    if (role === "DPS" && counts.dps >= caps.maxDps) {
      return false;
    }
    if (raidSchedule.assignments.length >= raidSchedule.raid.capacity) {
      return false;
    }

    const assignment: Assignment = {
      raidId: raidSchedule.raid.id,
      characterId: character.id,
      playerId: character.playerId,
      assignedRole: role
    };
    raidSchedule.assignments.push(assignment);

    assignedRaidsByCharacter.set(character.id, assignedCount + 1);
    const nextAssignedNames = assignedRaidNamesByCharacter.get(character.id) ?? new Set<string>();
    nextAssignedNames.add(normalizeRaidName(raidSchedule.raid.name));
    assignedRaidNamesByCharacter.set(character.id, nextAssignedNames);

    const nextAssignedIds = assignedRaidIdsByCharacter.get(character.id) ?? new Set<string>();
    nextAssignedIds.add(raidSchedule.raid.id);
    assignedRaidIdsByCharacter.set(character.id, nextAssignedIds);

    const slotList = assignmentsByPlayer.get(character.playerId) ?? [];
    slotList.push({
      raidId: raidSchedule.raid.id,
      dayOfWeek: raidSchedule.raid.dayOfWeek,
      startMinute: raidSchedule.raid.startMinute,
      endMinute: raidSchedule.raid.startMinute + raidSchedule.raid.durationMinutes
    });
    assignmentsByPlayer.set(character.playerId, slotList);

    return true;
  };

  const getAssignmentsForCharacter = (characterId: string): Array<{ raidSchedule: RaidSchedule; assignment: Assignment }> => {
    const results: Array<{ raidSchedule: RaidSchedule; assignment: Assignment }> = [];
    for (const raidSchedule of raidSchedules) {
      for (const assignment of raidSchedule.assignments) {
        if (assignment.characterId === characterId) {
          results.push({ raidSchedule, assignment });
        }
      }
    }
    return results;
  };

  for (const targetRaidSchedule of raidSchedules) {
    const caps = roleCaps(targetRaidSchedule.raid.capacity);

    let changed = true;
    while (changed) {
      changed = false;
      const counts = getRoleCounts(targetRaidSchedule);
      const needsSupport = counts.support < caps.maxSupport;
      const needsDps = counts.dps < caps.maxDps;
      if (!needsSupport && !needsDps) {
        break;
      }

      const preferredRoles: Array<"Support" | "DPS"> = [];
      if (needsSupport) {
        preferredRoles.push("Support");
      }
      if (needsDps) {
        preferredRoles.push("DPS");
      }

      for (const role of preferredRoles) {
        // Direct add first.
        for (const character of characters) {
          if (addAssignment(targetRaidSchedule, character, role)) {
            changed = true;
            break;
          }
        }
        if (changed) {
          break;
        }

        // Try one-for-one swap: move capped character into target and replace in source.
        for (const character of characters) {
          const assignedCount = assignedRaidsByCharacter.get(character.id) ?? 0;
          if (assignedCount < MAX_RAIDS_PER_CHARACTER) {
            continue;
          }

          const snapshots = getAssignmentsForCharacter(character.id);
          for (const snapshot of snapshots) {
            const sourceRaidSchedule = snapshot.raidSchedule;
            const sourceAssignment = snapshot.assignment;

            if (sourceRaidSchedule === targetRaidSchedule) {
              continue;
            }

            if (!removeAssignment(sourceRaidSchedule, sourceAssignment)) {
              continue;
            }

            const moved = addAssignment(targetRaidSchedule, character, role);
            if (!moved) {
              addAssignment(sourceRaidSchedule, character, sourceAssignment.assignedRole);
              continue;
            }

            let replaced = false;
            for (const replacement of characters) {
              if (replacement.id === character.id) {
                continue;
              }
              if (addAssignment(sourceRaidSchedule, replacement, sourceAssignment.assignedRole)) {
                replaced = true;
                break;
              }
            }

            if (replaced) {
              changed = true;
              break;
            }

            // Roll back if we cannot keep source fill.
            const rollbackTargetAssignment = targetRaidSchedule.assignments.find((a) => a.characterId === character.id && a.raidId === targetRaidSchedule.raid.id);
            if (rollbackTargetAssignment) {
              removeAssignment(targetRaidSchedule, rollbackTargetAssignment);
            }
            addAssignment(sourceRaidSchedule, character, sourceAssignment.assignedRole);
          }

          if (changed) {
            break;
          }
        }

        if (changed) {
          break;
        }
      }
    }
  }

  for (const raidSchedule of raidSchedules) {
    raidSchedule.isFull = raidSchedule.assignments.length === raidSchedule.raid.capacity;
    raidSchedule.warnings = [];
    if (!raidSchedule.isFull) {
      raidSchedule.warnings.push(
        `Raid underfilled: assigned ${raidSchedule.assignments.length}/${raidSchedule.raid.capacity}. Up to 2 slots remain reserved for supports.`
      );
    }
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

  for (const [characterId, requiredRaidIds] of requiredRaidIdsByVipCharacter.entries()) {
    const assignedIds = assignedRaidIdsByCharacter.get(characterId) ?? new Set<string>();
    for (const raidId of requiredRaidIds) {
      if (!assignedIds.has(raidId)) {
        return {
          raidSchedules: [],
          unassignedRaidIds: [],
          playerDeadtime: []
        };
      }
    }
  }

  return {
    raidSchedules,
    unassignedRaidIds,
    playerDeadtime
  };
}
