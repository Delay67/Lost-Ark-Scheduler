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
  raid: string;
  corePlayers: Record<string, string>;
  supports: string[];
  count: number;
  startMinute: number;
  durationMinutes: number;
  dayOfWeek: number;
  rowKey: string;
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

  const discoveredPlayers = new Set<string>();
  for (const raid of schedule.raidSchedules) {
    for (const assignment of raid.assignments) {
      const playerName = playerById.get(assignment.playerId);
      if (playerName) {
        discoveredPlayers.add(playerName);
      }
    }
  }

  const baseOrder = options?.corePlayerOrder && options.corePlayerOrder.length > 0
    ? options.corePlayerOrder
    : input.players.map((p) => p.name);

  const corePlayerOrder = [...baseOrder];
  for (const discovered of [...discoveredPlayers]) {
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
    if (raidSchedule.assignments.length === 0) {
      continue;
    }

    const corePlayers: Record<string, string> = {};
    for (const playerName of corePlayerOrder) {
      corePlayers[playerName] = "";
    }

    const supports: string[] = [];

    for (const assignment of raidSchedule.assignments) {
      const playerName = playerById.get(assignment.playerId) ?? assignment.playerId;
      const character = characterById.get(assignment.characterId);

      if (corePlayers[playerName] !== undefined && corePlayers[playerName] === "") {
        corePlayers[playerName] = playerName;
      }

      if (assignment.assignedRole === "Support") {
        supports.push(character?.name ?? playerName);
        continue;
      }
    }

    rows.push({
      dayOfWeek: raidSchedule.raid.dayOfWeek,
      row: {
        notes: "",
        time: formatMinuteOfDay(raidSchedule.raid.startMinute),
        raid: `${raidSchedule.raid.name}-${raidSchedule.raid.difficulty}`,
        corePlayers,
        supports,
        count: raidSchedule.assignments.length,
        startMinute: raidSchedule.raid.startMinute,
        durationMinutes: raidSchedule.raid.durationMinutes,
        dayOfWeek: raidSchedule.raid.dayOfWeek,
        rowKey: `${raidSchedule.raid.id}-${raidSchedule.raid.dayOfWeek}-${raidSchedule.raid.startMinute}`
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
