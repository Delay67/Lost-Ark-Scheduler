import {
  DAY_NAMES,
  daySortKeyFromWeekStart,
  formatMinuteOfDay,
  type Character,
  type GenerateScheduleInput,
  type ScheduleResult
} from "@las/shared";

type GridOptions = {
  weekStartDay?: number;
  corePlayerOrder?: string[];
};

type GridRow = {
  notes: string;
  time: string;
  day: string;
  raid: string;
  corePlayers: Record<string, string>;
  extras: string[];
  supports: string[];
  count: number;
};

type DayBlock = {
  dayOfWeek: number;
  day: string;
  rows: GridRow[];
};

export type WeeklyGridOutput = {
  columns: {
    corePlayers: string[];
    supports: number;
  };
  days: DayBlock[];
};

function sortByWeekStart(dayA: number, dayB: number, weekStartDay: number): number {
  return daySortKeyFromWeekStart(dayA, weekStartDay) - daySortKeyFromWeekStart(dayB, weekStartDay);
}

export function toWeeklyGrid(
  input: GenerateScheduleInput,
  schedule: ScheduleResult,
  options?: GridOptions
): WeeklyGridOutput {
  const weekStartDay = options?.weekStartDay ?? 3;
  const playerById = new Map(input.players.map((p) => [p.id, p.name]));
  const characterById = new Map(input.characters.map((c) => [c.id, c]));

  const discoveredDpsPlayers = new Set<string>();
  for (const raid of schedule.raidSchedules) {
    for (const assignment of raid.assignments) {
      if (assignment.assignedRole !== "DPS") {
        continue;
      }
      const playerName = playerById.get(assignment.playerId);
      if (playerName) {
        discoveredDpsPlayers.add(playerName);
      }
    }
  }

  const baseOrder = options?.corePlayerOrder && options.corePlayerOrder.length > 0
    ? options.corePlayerOrder
    : [...discoveredDpsPlayers].sort((a, b) => a.localeCompare(b));

  const corePlayerOrder = [...baseOrder];
  for (const discovered of [...discoveredDpsPlayers].sort((a, b) => a.localeCompare(b))) {
    if (!corePlayerOrder.includes(discovered)) {
      corePlayerOrder.push(discovered);
    }
  }

  const rows: { dayOfWeek: number; row: GridRow }[] = [];

  for (const raidSchedule of [...schedule.raidSchedules].sort((a, b) => {
    const daySort = sortByWeekStart(a.raid.dayOfWeek, b.raid.dayOfWeek, weekStartDay);
    if (daySort !== 0) {
      return daySort;
    }
    return a.raid.startMinute - b.raid.startMinute;
  })) {
    const corePlayers: Record<string, string> = {};
    for (const playerName of corePlayerOrder) {
      corePlayers[playerName] = "";
    }

    const extras: string[] = [];
    const supports: string[] = [];

    for (const assignment of raidSchedule.assignments) {
      const playerName = playerById.get(assignment.playerId) ?? assignment.playerId;
      const character = characterById.get(assignment.characterId);

      if (assignment.assignedRole === "Support") {
        supports.push(character?.name ?? playerName);
        continue;
      }

      if (corePlayers[playerName] !== undefined && corePlayers[playerName] === "") {
        corePlayers[playerName] = playerName;
      } else {
        extras.push(playerName);
      }
    }

    rows.push({
      dayOfWeek: raidSchedule.raid.dayOfWeek,
      row: {
        notes: raidSchedule.raid.notes ?? "",
        time: formatMinuteOfDay(raidSchedule.raid.startMinute),
        day: DAY_NAMES[raidSchedule.raid.dayOfWeek],
        raid: raidSchedule.raid.name,
        corePlayers,
        extras,
        supports,
        count: raidSchedule.assignments.length
      }
    });
  }

  const byDay = new Map<number, GridRow[]>();
  for (const entry of rows) {
    const dayRows = byDay.get(entry.dayOfWeek) ?? [];
    dayRows.push(entry.row);
    byDay.set(entry.dayOfWeek, dayRows);
  }

  const dayOrder = [...byDay.keys()].sort((a, b) => sortByWeekStart(a, b, weekStartDay));

  return {
    columns: {
      corePlayers: corePlayerOrder,
      supports: 2
    },
    days: dayOrder.map((dayOfWeek) => ({
      dayOfWeek,
      day: DAY_NAMES[dayOfWeek],
      rows: byDay.get(dayOfWeek) ?? []
    }))
  };
}
