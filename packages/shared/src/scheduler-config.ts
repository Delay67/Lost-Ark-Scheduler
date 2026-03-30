/**
 * Scheduler Configuration
 * 
 * Allows customization of solver behavior including:
 * - Soft objective weights (priority ordering and importance)
 * - Hard constraint toggles
 * - Optimization parameters
 */

import { z } from "zod";

/**
 * Schema for soft objective weights
 * Higher weight = higher priority in optimization
 */
export const SoftObjectiveWeightsSchema = z.object({
  /** Minimize VIP/required assignments left out */
  priorityWeight: z.number().int().positive().default(1000),

  /** Maximize total assignments (fill requirements) */
  fillRequiredWeight: z.number().int().nonnegative().default(100),

  /** Minimize underfilled raids */
  underfilledWeight: z.number().int().nonnegative().default(50),

  /** Minimize largest deadtime gap for any player */
  maxGapWeight: z.number().int().nonnegative().default(20),

  /** Minimize total deadtime across all players */
  totalGapWeight: z.number().int().nonnegative().default(10),

  /** Minimize raids exceeding 8 per day */
  dayOverflowWeight: z.number().int().nonnegative().default(15),

  /** Minimize same raid streaks exceeding 2 */
  streakExcessWeight: z.number().int().nonnegative().default(10),
});

export type SoftObjectiveWeights = z.infer<typeof SoftObjectiveWeightsSchema>;

/**
 * Schema for hard constraint toggles
 * These are usually fixed but can be disabled for experimentation
 */
export const HardConstraintsConfigSchema = z.object({
  /** Enforce max 3 raids per character */
  maxRaidsPerCharacter: z.boolean().default(true),

  /** Enforce no time conflicts */
  noTimeConflicts: z.boolean().default(true),

  /** Enforce availability windows */
  respectAvailability: z.boolean().default(true),

  /** Enforce no duplicate raid names per character */
  noDuplicateRaidNames: z.boolean().default(true),

  /** Enforce item level requirements */
  itemLevelRequirements: z.boolean().default(true),

  /** Enforce role requirements */
  roleRequirements: z.boolean().default(true),

  /** Maximum raids per character (when enabled) */
  maxRaidsPerCharacterLimit: z.number().int().positive().default(3),
});

export type HardConstraintsConfig = z.infer<typeof HardConstraintsConfigSchema>;

/**
 * Full scheduler configuration
 */
export const SchedulerConfigSchema = z.object({
  /** Soft objective weights */
  softObjectives: SoftObjectiveWeightsSchema.optional(),

  /** Hard constraint toggles */
  hardConstraints: HardConstraintsConfigSchema.optional(),

  /** Solver timeout in seconds */
  timeoutSeconds: z.number().int().positive().default(30),

  /** Enable verbose logging for debugging */
  logSearch: z.boolean().default(false),

  /** Enable detailed constraint violation logging */
  logViolations: z.boolean().default(false),

  /** Maximum number of attempts for iterative solvers */
  maxAttempts: z.number().int().positive().default(1000),

  /** Early stop after N attempts without improvement */
  earlyStopNoImproveAttempts: z.number().int().nonnegative().optional(),

  /** Random seed for reproducibility */
  seed: z.number().int().min(0).optional(),
});

export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;

/**
 * Default configuration (all defaults)
 */
export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  softObjectives: SoftObjectiveWeightsSchema.parse({}),
  hardConstraints: HardConstraintsConfigSchema.parse({}),
  timeoutSeconds: 30,
  logSearch: false,
  logViolations: false,
  maxAttempts: 1000,
};

/**
 * Preset configurations for different use cases
 */
export const SCHEDULER_PRESETS = {
  /** Fast heuristic - prioritize speed over optimization */
  fast: {
    softObjectives: {
      priorityWeight: 1000,
      fillRequiredWeight: 50,
      underfilledWeight: 10,
      maxGapWeight: 5,
      totalGapWeight: 2,
      dayOverflowWeight: 5,
      streakExcessWeight: 2,
    },
    timeoutSeconds: 5,
    maxAttempts: 100,
    logSearch: false,
  } satisfies Partial<SchedulerConfig>,

  /** Balanced - good trade-off between speed and quality */
  balanced: {
    softObjectives: {
      priorityWeight: 1000,
      fillRequiredWeight: 100,
      underfilledWeight: 50,
      maxGapWeight: 20,
      totalGapWeight: 10,
      dayOverflowWeight: 15,
      streakExcessWeight: 10,
    },
    timeoutSeconds: 30,
    maxAttempts: 1000,
    logSearch: false,
  } satisfies Partial<SchedulerConfig>,

  /** Thorough - prioritize best possible schedule */
  thorough: {
    softObjectives: {
      priorityWeight: 2000,
      fillRequiredWeight: 200,
      underfilledWeight: 100,
      maxGapWeight: 50,
      totalGapWeight: 30,
      dayOverflowWeight: 30,
      streakExcessWeight: 20,
    },
    timeoutSeconds: 120,
    maxAttempts: 5000,
    earlyStopNoImproveAttempts: 500,
    logSearch: false,
  } satisfies Partial<SchedulerConfig>,

  /** Testing - all logging enabled */
  testing: {
    softObjectives: {
      priorityWeight: 1000,
      fillRequiredWeight: 100,
      underfilledWeight: 50,
      maxGapWeight: 20,
      totalGapWeight: 10,
      dayOverflowWeight: 15,
      streakExcessWeight: 10,
    },
    timeoutSeconds: 30,
    maxAttempts: 1000,
    logSearch: true,
    logViolations: true,
  } satisfies Partial<SchedulerConfig>,

  /** VIP-first - maximize VIP satisfaction even if slightly suboptimal overall */
  vipFirst: {
    softObjectives: {
      priorityWeight: 5000,
      fillRequiredWeight: 100,
      underfilledWeight: 25,
      maxGapWeight: 10,
      totalGapWeight: 5,
      dayOverflowWeight: 10,
      streakExcessWeight: 5,
    },
    timeoutSeconds: 60,
    maxAttempts: 2000,
    logSearch: false,
  } satisfies Partial<SchedulerConfig>,

  /** Fairness-first - minimize deadtime gaps evenly across players */
  fairness: {
    softObjectives: {
      priorityWeight: 500,
      fillRequiredWeight: 50,
      underfilledWeight: 30,
      maxGapWeight: 100,
      totalGapWeight: 50,
      dayOverflowWeight: 20,
      streakExcessWeight: 15,
    },
    timeoutSeconds: 60,
    maxAttempts: 2000,
    logSearch: false,
  } satisfies Partial<SchedulerConfig>,
};

/**
 * Merge user config with defaults
 */
export function mergeConfig(
  userConfig: Partial<SchedulerConfig>,
  baseConfig: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG
): SchedulerConfig {
  return SchedulerConfigSchema.parse({
    ...baseConfig,
    ...userConfig,
    softObjectives: {
      ...(baseConfig.softObjectives ?? {}),
      ...(userConfig.softObjectives ?? {}),
    },
    hardConstraints: {
      ...(baseConfig.hardConstraints ?? {}),
      ...(userConfig.hardConstraints ?? {}),
    },
  });
}

/**
 * Load preset configuration
 */
export function loadPreset(
  presetName: keyof typeof SCHEDULER_PRESETS
): SchedulerConfig {
  const preset = SCHEDULER_PRESETS[presetName];
  return mergeConfig(preset);
}

/**
 * Validate configuration
 */
export function validateConfig(config: unknown): SchedulerConfig {
  return SchedulerConfigSchema.parse(config);
}
