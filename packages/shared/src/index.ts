import { z } from "zod";

export const RoleSchema = z.enum(["DPS", "Support", "DPS/Support"]);
export const AssignedRoleSchema = z.enum(["DPS", "Support"]);
export const DifficultySchema = z.enum(["Normal", "Hard", "Nightmare"]);

export const DayOfWeekSchema = z.number().int().min(0).max(6);
export const MinuteOfDaySchema = z.number().int().min(0).max(24 * 60 - 1);

const PlayerCreateSchemaBase = z.object({
  name: z.string().min(1),
  vip: z.boolean().default(false)
});

const CharacterCreateSchemaBase = z.object({
  playerId: z.string().min(1),
  name: z.string().min(1),
  role: RoleSchema,
  itemLevel: z.number().int().positive(),
  raidOptOutRaidIds: z.array(z.string().min(1)).default([])
});

const AvailabilityWindowCreateSchemaBase = z.object({
  playerId: z.string().min(1),
  dayOfWeek: DayOfWeekSchema,
  startMinute: MinuteOfDaySchema,
  endMinute: z.number().int().min(1).max(24 * 60)
});

const RaidCreateSchemaBase = z.object({
  name: z.string().min(1),
  difficulty: DifficultySchema,
  itemLevelRequirement: z.number().int().positive(),
  durationMinutes: z.number().int().positive().max(24 * 60)
});

export const PlayerCreateSchema = PlayerCreateSchemaBase;
export const PlayerSchema = PlayerCreateSchemaBase.extend({
  id: z.string().min(1)
});

export const CharacterCreateSchema = CharacterCreateSchemaBase;
export const CharacterSchema = CharacterCreateSchemaBase.extend({
  id: z.string().min(1)
});

export const AvailabilityWindowCreateSchema = AvailabilityWindowCreateSchemaBase.refine((w) => w.endMinute > w.startMinute, {
  message: "endMinute must be greater than startMinute"
});

export const AvailabilityWindowSchema = AvailabilityWindowCreateSchemaBase.extend({
  id: z.string().min(1)
}).refine((w) => w.endMinute > w.startMinute, {
  message: "endMinute must be greater than startMinute"
});

export const RaidCreateSchema = RaidCreateSchemaBase;

export const RaidInstanceSchema = RaidCreateSchemaBase.extend({
  id: z.string().min(1)
});

export const AssignmentSchema = z.object({
  raidId: z.string().min(1),
  characterId: z.string().min(1),
  playerId: z.string().min(1),
  assignedRole: AssignedRoleSchema
});

export const DataStoreSchema = z.object({
  players: z.array(PlayerSchema),
  characters: z.array(CharacterSchema),
  raids: z.array(RaidInstanceSchema),
  availabilityWindows: z.array(AvailabilityWindowSchema)
});

export const GenerateScheduleInputSchema = z.object({
  players: z.array(PlayerSchema),
  characters: z.array(CharacterSchema),
  raids: z.array(RaidInstanceSchema),
  availabilityWindows: z.array(AvailabilityWindowSchema)
});

export type Role = z.infer<typeof RoleSchema>;
export type AssignedRole = z.infer<typeof AssignedRoleSchema>;
export type Difficulty = z.infer<typeof DifficultySchema>;
export type PartySize = 4 | 8;
export type Player = z.infer<typeof PlayerSchema>;
export type Character = z.infer<typeof CharacterSchema>;
export type RaidInstance = z.infer<typeof RaidInstanceSchema>;
export type AvailabilityWindow = z.infer<typeof AvailabilityWindowSchema>;
export type Assignment = z.infer<typeof AssignmentSchema>;
export type DataStore = z.infer<typeof DataStoreSchema>;
export type GenerateScheduleInput = z.infer<typeof GenerateScheduleInputSchema>;

export type RaidSchedule = {
  raid: ScheduledRaid;
  assignments: Assignment[];
  isFull: boolean;
  warnings: string[];
};

export type ScheduledRaid = RaidInstance & {
  dayOfWeek: number;
  startMinute: number;
  capacity: PartySize;
};

export type PlayerDeadtimeSummary = {
  playerId: string;
  totalGapMinutes: number;
  largestGapMinutes: number;
  assignmentCount: number;
};

export type ScheduleResult = {
  raidSchedules: RaidSchedule[];
  unassignedRaidIds: string[];
  playerDeadtime: PlayerDeadtimeSummary[];
};

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function daySortKeyFromWeekStart(dayOfWeek: number, weekStartDay: number): number {
  return (dayOfWeek - weekStartDay + 7) % 7;
}

export function formatMinuteOfDay(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function roleCaps(capacity: PartySize): { maxDps: number; maxSupport: number } {
  return capacity === 8
    ? { maxDps: 6, maxSupport: 2 }
    : { maxDps: 3, maxSupport: 1 };
}
