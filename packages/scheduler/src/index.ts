import {
  type Assignment,
  type Character,
  daySortKeyFromWeekStart,
  type GenerateScheduleInput,
  type PlayerDeadtimeSummary,
  type RaidInstance,
  type RaidSchedule,
  type Role,
  type ScheduleResult,
  roleCaps
} from "@las/shared";

type PlayerRaidSlot = {
  raidId: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
};

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function playerIsAvailable(
  playerId: string,
  raid: RaidInstance,
  availabilityByPlayer: Map<string, { dayOfWeek: number; startMinute: number; endMinute: number }[]>
): boolean {
  const windows = availabilityByPlayer.get(playerId) ?? [];
  const raidEnd = raid.startMinute + raid.durationMinutes;
  return windows.some((w) => {
    if (w.dayOfWeek !== raid.dayOfWeek) {
      return false;
    }
    return w.startMinute <= raid.startMinute && w.endMinute >= raidEnd;
  });
}

function canTakeRole(characterRole: Role, neededRole: "DPS" | "Support"): boolean {
  if (characterRole === "DPS/Support") {
    return true;
  }
  return characterRole === neededRole;
}

function hasRaidConflict(playerSlots: PlayerRaidSlot[], raid: RaidInstance): boolean {
  const raidEnd = raid.startMinute + raid.durationMinutes;
  return playerSlots.some((slot) => {
    if (slot.dayOfWeek !== raid.dayOfWeek) {
      return false;
    }
    return overlaps(slot.startMinute, slot.endMinute, raid.startMinute, raidEnd);
  });
}

function contiguityScore(playerSlots: PlayerRaidSlot[], raid: RaidInstance): number {
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

export function generateWeeklySchedule(input: GenerateScheduleInput): ScheduleResult {
  const availabilityByPlayer = new Map<string, { dayOfWeek: number; startMinute: number; endMinute: number }[]>();
  for (const window of input.availabilityWindows) {
    const list = availabilityByPlayer.get(window.playerId) ?? [];
    list.push(window);
    availabilityByPlayer.set(window.playerId, list);
  }

  const characters = [...input.characters];
  const raids = [...input.raids].sort((a, b) => {
    const dayKeyA = daySortKeyFromWeekStart(a.dayOfWeek, 3);
    const dayKeyB = daySortKeyFromWeekStart(b.dayOfWeek, 3);
    if (dayKeyA !== dayKeyB) {
      return dayKeyA - dayKeyB;
    }
    if (a.startMinute !== b.startMinute) {
      return a.startMinute - b.startMinute;
    }
    return b.itemLevelRequirement - a.itemLevelRequirement;
  });

  const assignmentsByPlayer = new Map<string, PlayerRaidSlot[]>();
  const raidSchedules: RaidSchedule[] = [];

  for (const raid of raids) {
    const caps = roleCaps(raid.capacity);
    const raidAssignments: Assignment[] = [];
    const usedCharacterIds = new Set<string>();
    let supportCount = 0;
    let dpsCount = 0;

    const candidates = characters.filter((c) => {
      if (c.itemLevel < raid.itemLevelRequirement) {
        return false;
      }
      if (!playerIsAvailable(c.playerId, raid, availabilityByPlayer)) {
        return false;
      }
      const slots = assignmentsByPlayer.get(c.playerId) ?? [];
      if (hasRaidConflict(slots, raid)) {
        return false;
      }
      return true;
    });

    const sortedCandidates = [...candidates].sort((a, b) => {
      const aSlots = assignmentsByPlayer.get(a.playerId) ?? [];
      const bSlots = assignmentsByPlayer.get(b.playerId) ?? [];
      const scoreDiff = contiguityScore(bSlots, raid) - contiguityScore(aSlots, raid);
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

        const slotList = assignmentsByPlayer.get(character.playerId) ?? [];
        slotList.push({
          raidId: raid.id,
          dayOfWeek: raid.dayOfWeek,
          startMinute: raid.startMinute,
          endMinute: raid.startMinute + raid.durationMinutes
        });
        assignmentsByPlayer.set(character.playerId, slotList);
        return true;
      }
      return false;
    };

    while (supportCount < caps.maxSupport && raidAssignments.length < raid.capacity) {
      const assigned = tryAssign("Support");
      if (!assigned) {
        break;
      }
      supportCount += 1;
    }

    while (dpsCount < caps.maxDps && raidAssignments.length < raid.capacity) {
      const assigned = tryAssign("DPS");
      if (!assigned) {
        break;
      }
      dpsCount += 1;
    }

    const warnings: string[] = [];
    if (raidAssignments.length < raid.capacity) {
      warnings.push(
        `Raid underfilled: assigned ${raidAssignments.length}/${raid.capacity} due to availability, ilvl, or overlap constraints.`
      );
    }

    raidSchedules.push({
      raid,
      assignments: raidAssignments,
      isFull: raidAssignments.length === raid.capacity,
      warnings
    });
  }

  const unassignedRaidIds = raidSchedules.filter((r) => !r.isFull).map((r) => r.raid.id);
  const playerDeadtime = summarizeDeadtime(assignmentsByPlayer);

  return {
    raidSchedules,
    unassignedRaidIds,
    playerDeadtime
  };
}
