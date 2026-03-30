/**
 * Scheduler Domain Layer
 * 
 * Canonical types and interfaces for the Lost Ark scheduler.
 * These types define the contract that all scheduler engines must implement.
 * They are the single source of truth for data shapes flowing through the system.
 */

export {
  type Role,
  type AssignedRole,
  type Difficulty,
  type PartySize,
  type Player,
  type Character,
  type RaidInstance,
  type AvailabilityWindow,
  type Assignment,
  type RaidSchedule,
  type ScheduledRaid,
  type PlayerDeadtimeSummary,
  type ScheduleResult,
  RoleSchema,
  AssignedRoleSchema,
  DifficultySchema,
  DayOfWeekSchema,
  MinuteOfDaySchema,
  PlayerSchema,
  PlayerCreateSchema,
  CharacterSchema,
  CharacterCreateSchema,
  AvailabilityWindowSchema,
  AvailabilityWindowCreateSchema,
  RaidInstanceSchema,
  RaidCreateSchema,
  AssignmentSchema,
  GenerateScheduleInputSchema,
  DataStoreSchema,
  DAY_NAMES,
  daySortKeyFromWeekStart,
  formatMinuteOfDay,
  roleCaps
} from "./index.js";

/**
 * Domain input - the canonical scheduler input format.
 * All engines receive and process this format identically.
 */
export type SchedulerInput = {
  players: Array<{
    id: string;
    name: string;
    vip: boolean;
  }>;
  characters: Array<{
    id: string;
    playerId: string;
    name: string;
    role: "DPS" | "Support" | "DPS/Support";
    itemLevel: number;
    raidOptOutRaidIds: string[];
  }>;
  raids: Array<{
    id: string;
    name: string;
    difficulty: "Normal" | "Hard" | "Nightmare";
    itemLevelRequirement: number;
    durationMinutes: number;
  }>;
  availabilityWindows: Array<{
    id: string;
    playerId: string;
    dayOfWeek: number;
    startMinute: number;
    endMinute: number;
  }>;
};

/**
 * Domain output - the canonical scheduler output format.
 * All engines produce output in this format for consistent downstream consumption.
 */
export type SchedulerOutput = {
  raidSchedules: Array<{
    raid: {
      id: string;
      name: string;
      difficulty: "Normal" | "Hard" | "Nightmare";
      itemLevelRequirement: number;
      durationMinutes: number;
      dayOfWeek: number;
      startMinute: number;
      capacity: 4 | 8;
    };
    assignments: Array<{
      raidId: string;
      characterId: string;
      playerId: string;
      assignedRole: "DPS" | "Support";
    }>;
    isFull: boolean;
    warnings: string[];
  }>;
  unassignedRaidIds: string[];
  playerDeadtime: Array<{
    playerId: string;
    totalGapMinutes: number;
    largestGapMinutes: number;
    assignmentCount: number;
  }>;
};

/**
 * Scheduler engine interface.
 * All scheduler implementations must conform to this contract.
 */
export interface ISchedulerEngine {
  /**
   * Generate a weekly schedule given the input constraints and preferences.
   * @param input The canonical scheduler input
   * @param options Optional generation parameters
   * @returns Promise that resolves to the canonical scheduler output
   */
  generateSchedule(
    input: SchedulerInput,
    options?: SchedulerOptions
  ): Promise<SchedulerOutput>;
}

/**
 * Options for schedule generation
 */
export type SchedulerOptions = {
  /** Number of attempts/iterations for optimization (default: 1000) */
  attempts?: number;
  
  /** Random seed for reproducibility */
  seed?: number;
  
  /** Early stop after N attempts without improvement */
  earlyStopNoImproveAttempts?: number;
  
  /** Callback for progress updates */
  onAttemptCompleted?: (completedAttempts: number, totalAttempts: number) => void;
};

/**
 * Quality metrics for evaluating schedule results
 */
export type ScheduleQuality = {
  /** Number of required assignments that were skipped */
  leftOutRequiredCount: number;
  
  /** Total number of characters assigned to raids */
  assignedCount: number;
  
  /** Number of raids not at full capacity */
  underfilledCount: number;
  
  /** Maximum deadtime gap for any player */
  maxGapMinutes: number;
  
  /** Total deadtime across all players */
  totalGapMinutes: number;
};

/**
 * Adapter: Convert GenerateScheduleInput to SchedulerInput
 * Bridges existing API to new canonical domain format
 */
export function toSchedulerInput(input: any): SchedulerInput {
  return {
    players: input.players,
    characters: input.characters,
    raids: input.raids,
    availabilityWindows: input.availabilityWindows
  };
}

/**
 * Adapter: Convert ScheduleResult to SchedulerOutput
 * Bridges existing API from new canonical domain format
 */
export function toSchedulerOutput(result: any): SchedulerOutput {
  return {
    raidSchedules: result.raidSchedules,
    unassignedRaidIds: result.unassignedRaidIds,
    playerDeadtime: result.playerDeadtime
  };
}
