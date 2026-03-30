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
      const dayGap = cur.dayOfWeek - prev.dayOfWeek;

      if (dayGap === 0) {
        const gap = Math.max(0, cur.startMinute - prev.endMinute);
        totalGapMinutes += gap;
        largestGapMinutes = Math.max(largestGapMinutes, gap);
      } else {
        const wrapGap = dayGap * 24 * 60 + cur.startMinute - prev.endMinute;
        totalGapMinutes += wrapGap;
        largestGapMinutes = Math.max(largestGapMinutes, wrapGap);
      }
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
  availabilityByPlayer: Map<string, { dayOfWeek: number; startMinute: number; endMinute: number }[]>,
  assignmentsByPlayer: Map<string, PlayerRaidSlot[]>,
  assignedRaidsByCharacter: Map<string, number>,
  allowedRaidIdsByCharacter: Map<string, Set<string>>
): { scheduledRaid: ScheduledRaid; assignments: Assignment[] } {
  const capacity = partySizeForRaid(raid);
  const scheduledRaid: ScheduledRaid = {
    ...raid,
    capacity,
    dayOfWeek: slot.dayOfWeek,
    startMinute: slot.startMinute
  };

  const caps = roleCaps(capacity);
  const raidAssignments: Assignment[] = [];
  const usedCharacterIds = new Set<string>();
  let supportCount = 0;
  let dpsCount = 0;

  const candidates = characters.filter((c) => {
    const allowedRaidIds = allowedRaidIdsByCharacter.get(c.id);
    if (!allowedRaidIds || !allowedRaidIds.has(raid.id)) {
      return false;
    }

    const assignedCount = assignedRaidsByCharacter.get(c.id) ?? 0;
    if (assignedCount >= MAX_RAIDS_PER_CHARACTER) {
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
    const scoreDiff = contiguityScore(bSlots, scheduledRaid) - contiguityScore(aSlots, scheduledRaid);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    if (a.itemLevel !== b.itemLevel) {
      return a.itemLevel - b.itemLevel;
    }
    return a.id.localeCompare(b.id);
  });

  const tryAssign = (neededRole: "DPS" | "Support") => {
    for (const character of sortedCandidates) {
      if (usedCharacterIds.has(character.id)) {
        continue;
      }
      if (!canTakeRole(character.role, neededRole)) {
        continue;
      }

      usedCharacterIds.add(character.id);
      raidAssignments.push({
        raidId: raid.id,
        characterId: character.id,
        playerId: character.playerId,
        assignedRole: neededRole
      });
      return true;
    }
    return false;
  };

  while (supportCount < caps.maxSupport && raidAssignments.length < capacity) {
    const assigned = tryAssign("Support");
    if (!assigned) {
      break;
    }
    supportCount += 1;
  }

  while (dpsCount < caps.maxDps && raidAssignments.length < capacity) {
    const assigned = tryAssign("DPS");
    if (!assigned) {
      break;
    }
    dpsCount += 1;
  }

  return { scheduledRaid, assignments: raidAssignments };
}

export function generateWeeklySchedule(input: GenerateScheduleInput): ScheduleResult {
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
  const allowedRaidIdsByCharacter = new Map<string, Set<string>>();

  const raidPriorityOrder = [...raids].sort((a, b) => {
    if (b.itemLevelRequirement !== a.itemLevelRequirement) {
      return b.itemLevelRequirement - a.itemLevelRequirement;
    }
    return a.id.localeCompare(b.id);
  });

  for (const character of characters) {
    const eligibleTopRaids = raidPriorityOrder
      .filter((raid) => character.itemLevel >= raid.itemLevelRequirement)
      .slice(0, MAX_RAIDS_PER_CHARACTER)
      .map((raid) => raid.id);
    allowedRaidIdsByCharacter.set(character.id, new Set(eligibleTopRaids));
  }

  const raidSchedules: RaidSchedule[] = [];

  for (const raid of raids) {
    const candidateSlots = buildCandidateSlots(raid, availabilityByPlayer);
    let best: { scheduledRaid: ScheduledRaid; assignments: Assignment[] } | null = null;

    for (const slot of candidateSlots) {
      const evaluation = evaluateSlot(
        raid,
        slot,
        characters,
        availabilityByPlayer,
        assignmentsByPlayer,
        assignedRaidsByCharacter,
        allowedRaidIdsByCharacter
      );
      if (!best || evaluation.assignments.length > best.assignments.length) {
        best = evaluation;
        continue;
      }

      if (!best) {
        continue;
      }

      if (evaluation.assignments.length === best.assignments.length) {
        const evalDay = daySortKeyFromWeekStart(evaluation.scheduledRaid.dayOfWeek, 3);
        const bestDay = daySortKeyFromWeekStart(best.scheduledRaid.dayOfWeek, 3);
        if (evalDay < bestDay || (evalDay === bestDay && evaluation.scheduledRaid.startMinute < best.scheduledRaid.startMinute)) {
          best = evaluation;
        }
      }
    }

    const scheduledRaid: ScheduledRaid = best?.scheduledRaid ?? {
      ...raid,
      capacity: partySizeForRaid(raid),
      dayOfWeek: 3,
      startMinute: 0
    };
    const raidAssignments = best?.assignments ?? [];

    for (const assignment of raidAssignments) {
      const currentCharacterCount = assignedRaidsByCharacter.get(assignment.characterId) ?? 0;
      assignedRaidsByCharacter.set(assignment.characterId, currentCharacterCount + 1);

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
    if (candidateSlots.length === 0) {
      warnings.push("No viable time slot found from current availability windows.");
    }
    if (raidAssignments.length < scheduledRaid.capacity) {
      warnings.push(
        `Raid underfilled: assigned ${raidAssignments.length}/${scheduledRaid.capacity} due to availability, ilvl, or overlap constraints.`
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

  const unassignedRaidIds = raidSchedules.filter((r) => !r.isFull).map((r) => r.raid.id);
  const playerDeadtime = summarizeDeadtime(assignmentsByPlayer);

  return {
    raidSchedules,
    unassignedRaidIds,
    playerDeadtime
  };
}
