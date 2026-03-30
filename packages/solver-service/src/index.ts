import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type {
  Assignment,
  Character,
  GenerateScheduleInput,
  PlayerDeadtimeSummary,
  RaidSchedule,
  ScheduleResult,
  SchedulerInput,
  SchedulerOptions,
  SchedulerOutput
} from "@las/shared";
import { roleCaps } from "@las/shared";
import { generateWeeklySchedule as generateBaselineWeeklySchedule } from "@las/scheduler-baseline";
import solver from "javascript-lp-solver";

export { type SchedulerInput, type SchedulerOutput, type SchedulerOptions };

type HardConstraints = {
  maxRaidsPerCharacter: number;
  noTimeConflicts: boolean;
  respectAvailability: boolean;
  noDuplicateRaidNames: boolean;
  itemLevelRequirements: boolean;
  roleRequirements: boolean;
};

type SoftObjectives = {
  priorityWeight: number;
  fillRequiredWeight: number;
  underfilledWeight: number;
  maxGapWeight: number;
  totalGapWeight: number;
  dayOverflowWeight: number;
  streakExcessWeight: number;
};

export type SolverConfig = {
  hardConstraints?: Partial<HardConstraints>;
  softObjectives?: Partial<SoftObjectives>;
  timeoutSeconds?: number;
  logSearch?: boolean;
};

const DEFAULT_HARD_CONSTRAINTS: HardConstraints = {
  maxRaidsPerCharacter: 3,
  noTimeConflicts: true,
  respectAvailability: true,
  noDuplicateRaidNames: true,
  itemLevelRequirements: true,
  roleRequirements: true
};

const DEFAULT_SOFT_OBJECTIVES: SoftObjectives = {
  priorityWeight: 1000,
  fillRequiredWeight: 100,
  underfilledWeight: 50,
  maxGapWeight: 20,
  totalGapWeight: 10,
  dayOverflowWeight: 15,
  streakExcessWeight: 10
};

type LpModel = {
  optimize: string;
  opType: "max" | "min";
  constraints: Record<string, { max?: number; min?: number; equal?: number }>;
  variables: Record<string, Record<string, number>>;
  ints: Record<string, 1>;
};

type SelectedAssignment = {
  raidIndex: number;
  characterId: string;
  playerId: string;
  assignedRole: "DPS" | "Support";
};

type CpSatSolveResult = {
  status: string;
  result?: ScheduleResult;
  error?: string;
};

function normalizeRaidName(name: string): string {
  return name.trim().toLowerCase();
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function canTakeRole(characterRole: Character["role"], neededRole: "DPS" | "Support"): boolean {
  if (characterRole === "DPS/Support") {
    return true;
  }
  return characterRole === neededRole;
}

function hasAvailability(
  input: GenerateScheduleInput,
  playerId: string,
  dayOfWeek: number,
  startMinute: number,
  durationMinutes: number
): boolean {
  const endMinute = startMinute + durationMinutes;
  return input.availabilityWindows.some((w) => (
    w.playerId === playerId
    && w.dayOfWeek === dayOfWeek
    && w.startMinute <= startMinute
    && w.endMinute >= endMinute
  ));
}

function buildRequiredRaidIdsByCharacter(input: GenerateScheduleInput, maxRaidsPerCharacter: number): Map<string, Set<string>> {
  const raids = [...input.raids].sort((a, b) => {
    if (b.itemLevelRequirement !== a.itemLevelRequirement) {
      return b.itemLevelRequirement - a.itemLevelRequirement;
    }
    return a.id.localeCompare(b.id);
  });

  const requiredByCharacter = new Map<string, Set<string>>();
  for (const character of input.characters) {
    const seenRaidNames = new Set<string>();
    const requiredRaidIds = new Set<string>();
    const optedOut = new Set(character.raidOptOutRaidIds ?? []);

    for (const raid of raids) {
      if (character.itemLevel < raid.itemLevelRequirement) {
        continue;
      }
      const nameKey = normalizeRaidName(raid.name);
      if (seenRaidNames.has(nameKey)) {
        continue;
      }
      seenRaidNames.add(nameKey);
      if (!optedOut.has(raid.id)) {
        requiredRaidIds.add(raid.id);
      }
      if (requiredRaidIds.size >= maxRaidsPerCharacter) {
        break;
      }
    }

    requiredByCharacter.set(character.id, requiredRaidIds);
  }

  return requiredByCharacter;
}

function summarizeDeadtime(raidSchedules: RaidSchedule[]): PlayerDeadtimeSummary[] {
  const slotsByPlayer = new Map<string, Array<{ dayOfWeek: number; startMinute: number; endMinute: number }>>();

  for (const raidSchedule of raidSchedules) {
    const endMinute = raidSchedule.raid.startMinute + raidSchedule.raid.durationMinutes;
    for (const assignment of raidSchedule.assignments) {
      const list = slotsByPlayer.get(assignment.playerId) ?? [];
      list.push({
        dayOfWeek: raidSchedule.raid.dayOfWeek,
        startMinute: raidSchedule.raid.startMinute,
        endMinute
      });
      slotsByPlayer.set(assignment.playerId, list);
    }
  }

  const summaries: PlayerDeadtimeSummary[] = [];
  for (const [playerId, slots] of slotsByPlayer.entries()) {
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

    summaries.push({ playerId, totalGapMinutes, largestGapMinutes, assignmentCount: sorted.length });
  }

  return summaries.sort((a, b) => a.playerId.localeCompare(b.playerId));
}

function buildScheduleFromAssignments(skeleton: ScheduleResult, selected: SelectedAssignment[]): ScheduleResult {
  const assignmentsByRaid = new Map<number, Assignment[]>();
  for (const row of selected) {
    const list = assignmentsByRaid.get(row.raidIndex) ?? [];
    list.push({
      raidId: skeleton.raidSchedules[row.raidIndex].raid.id,
      characterId: row.characterId,
      playerId: row.playerId,
      assignedRole: row.assignedRole
    });
    assignmentsByRaid.set(row.raidIndex, list);
  }

  const raidSchedules: RaidSchedule[] = skeleton.raidSchedules.map((s, idx) => {
    const assignments = assignmentsByRaid.get(idx) ?? [];
    const isFull = assignments.length === s.raid.capacity;
    return {
      raid: s.raid,
      assignments,
      isFull,
      warnings: isFull ? [] : [`Raid underfilled: assigned ${assignments.length}/${s.raid.capacity}. Up to 2 slots remain reserved for supports.`]
    };
  });

  const unassignedRaidIds = [...new Set(raidSchedules.filter((r) => !r.isFull).map((r) => r.raid.id))];
  return { raidSchedules, unassignedRaidIds, playerDeadtime: summarizeDeadtime(raidSchedules) };
}

function optimizeAssignmentsMilp(input: GenerateScheduleInput, skeleton: ScheduleResult, hard: HardConstraints, soft: SoftObjectives): ScheduleResult | null {
  const playersById = new Map(input.players.map((p) => [p.id, p]));
  const requiredByCharacter = buildRequiredRaidIdsByCharacter(input, hard.maxRaidsPerCharacter);

  const model: LpModel = { optimize: "score", opType: "max", constraints: {}, variables: {}, ints: {} };
  const addMaxConstraint = (id: string, max: number) => {
    if (!model.constraints[id]) {
      model.constraints[id] = { max };
    }
  };
  const addVariable = (name: string, coeffs: Record<string, number>) => {
    model.variables[name] = coeffs;
    model.ints[name] = 1;
  };

  type Decision = { variable: string; raidIndex: number; characterId: string; role: "DPS" | "Support"; playerId: string };
  const decisions: Decision[] = [];

  for (let raidIndex = 0; raidIndex < skeleton.raidSchedules.length; raidIndex += 1) {
    const raid = skeleton.raidSchedules[raidIndex].raid;
    const caps = roleCaps(raid.capacity);

    addMaxConstraint(`raid:${raidIndex}:capacity`, raid.capacity);
    addMaxConstraint(`raid:${raidIndex}:support`, caps.maxSupport);
    addMaxConstraint(`raid:${raidIndex}:dps`, caps.maxDps);

    for (const character of input.characters) {
      if (hard.itemLevelRequirements && character.itemLevel < raid.itemLevelRequirement) {
        continue;
      }
      if ((character.raidOptOutRaidIds ?? []).includes(raid.id)) {
        continue;
      }
      if (hard.respectAvailability && !hasAvailability(input, character.playerId, raid.dayOfWeek, raid.startMinute, raid.durationMinutes)) {
        continue;
      }

      const isRequired = requiredByCharacter.get(character.id)?.has(raid.id) ?? false;
      const isVip = playersById.get(character.playerId)?.vip ?? false;

      for (const neededRole of ["DPS", "Support"] as const) {
        if (hard.roleRequirements && !canTakeRole(character.role, neededRole)) {
          continue;
        }

        const varName = `x:${raidIndex}:${character.id}:${neededRole}`;
        const coeffs: Record<string, number> = {
          score: 10 + (isRequired ? soft.fillRequiredWeight : 0) + (isVip && isRequired ? soft.priorityWeight : 0),
          [`raid:${raidIndex}:capacity`]: 1,
          [`raid:${raidIndex}:${neededRole === "Support" ? "support" : "dps"}`]: 1,
          [`char:${character.id}:maxRaids`]: 1,
          [`playerRaid:${raidIndex}:${character.playerId}`]: 1
        };

        addMaxConstraint(`char:${character.id}:maxRaids`, hard.maxRaidsPerCharacter);
        addMaxConstraint(`playerRaid:${raidIndex}:${character.playerId}`, 1);

        if (hard.noDuplicateRaidNames) {
          const dupKey = `char:${character.id}:raidName:${normalizeRaidName(raid.name)}`;
          addMaxConstraint(dupKey, 1);
          coeffs[dupKey] = 1;
        }

        addVariable(varName, coeffs);
        decisions.push({ variable: varName, raidIndex, characterId: character.id, role: neededRole, playerId: character.playerId });
      }
    }
  }

  if (hard.noTimeConflicts) {
    const byPlayer = new Map<string, Decision[]>();
    for (const d of decisions) {
      const arr = byPlayer.get(d.playerId) ?? [];
      arr.push(d);
      byPlayer.set(d.playerId, arr);
    }

    for (const [playerId, rows] of byPlayer.entries()) {
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
          const a = rows[i];
          const b = rows[j];
          const raidA = skeleton.raidSchedules[a.raidIndex].raid;
          const raidB = skeleton.raidSchedules[b.raidIndex].raid;
          if (raidA.dayOfWeek !== raidB.dayOfWeek) {
            continue;
          }
          if (!overlaps(raidA.startMinute, raidA.startMinute + raidA.durationMinutes, raidB.startMinute, raidB.startMinute + raidB.durationMinutes)) {
            continue;
          }

          const key = `playerConflict:${playerId}:${a.raidIndex}:${b.raidIndex}`;
          addMaxConstraint(key, 1);
          model.variables[a.variable][key] = 1;
          model.variables[b.variable][key] = 1;
        }
      }
    }
  }

  const raw = (solver as unknown as { Solve: (m: LpModel) => Record<string, unknown> }).Solve(model);
  if (!raw || raw.feasible === false) {
    return null;
  }

  const selected: SelectedAssignment[] = [];
  for (const d of decisions) {
    const value = raw[d.variable];
    if (typeof value === "number" && value >= 0.5) {
      selected.push({ raidIndex: d.raidIndex, characterId: d.characterId, playerId: d.playerId, assignedRole: d.role });
    }
  }

  return buildScheduleFromAssignments(skeleton, selected);
}

function getPythonCandidates(): Array<{ command: string; args: string[] }> {
  const candidates: Array<{ command: string; args: string[] }> = [];
  if (process.env.LAS_PYTHON && process.env.LAS_PYTHON.trim().length > 0) {
    candidates.push({ command: process.env.LAS_PYTHON.trim(), args: [] });
  }

  const localVenvPython = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.venv/Scripts/python.exe");
  if (existsSync(localVenvPython)) {
    candidates.push({ command: localVenvPython, args: [] });
  }

  candidates.push({ command: "python", args: [] });
  candidates.push({ command: "py", args: ["-3"] });
  return candidates;
}

function tryRunCpSatPython(
  input: GenerateScheduleInput,
  hard: HardConstraints,
  soft: SoftObjectives,
  timeoutSeconds: number,
  logSearch: boolean
): ScheduleResult | null {
  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../cp_sat_solver.py");
  const payload = { input, hardConstraints: hard, softObjectives: soft, timeoutSeconds };

  for (const candidate of getPythonCandidates()) {
    try {
      const result = spawnSync(candidate.command, [...candidate.args, scriptPath], {
        input: JSON.stringify(payload),
        encoding: "utf-8",
        timeout: Math.max(1000, Math.floor(timeoutSeconds * 1000))
      });

      if (result.status !== 0) {
        continue;
      }

      const text = result.stdout?.trim();
      if (!text) {
        continue;
      }

      const parsed = JSON.parse(text) as CpSatSolveResult;
      if (parsed.status !== "optimal" && parsed.status !== "feasible") {
        if (logSearch && parsed.error) {
          console.warn(`[SolverService] CP-SAT status ${parsed.status}: ${parsed.error}`);
        }
        continue;
      }

      if (!parsed.result) {
        continue;
      }

      return parsed.result;
    } catch {
      continue;
    }
  }

  return null;
}

export class SolverService {
  private hardConstraints: HardConstraints;
  private softObjectives: SoftObjectives;
  private timeoutSeconds: number;
  private logSearch: boolean;

  constructor(config: SolverConfig = {}) {
    this.hardConstraints = { ...DEFAULT_HARD_CONSTRAINTS, ...config.hardConstraints };
    this.softObjectives = { ...DEFAULT_SOFT_OBJECTIVES, ...config.softObjectives };
    this.timeoutSeconds = config.timeoutSeconds ?? 30;
    this.logSearch = config.logSearch ?? false;
  }

  private buildSkeleton(input: GenerateScheduleInput, options?: SchedulerOptions): ScheduleResult {
    return generateBaselineWeeklySchedule(input, {
      attempts: Math.max(1, Math.min(options?.attempts ?? 200, 500)),
      seed: options?.seed,
      earlyStopNoImproveAttempts: options?.earlyStopNoImproveAttempts,
      onAttemptCompleted: options?.onAttemptCompleted
    });
  }

  async generateSchedule(input: SchedulerInput, options?: SchedulerOptions): Promise<SchedulerOutput> {
    if (this.logSearch) {
      console.log("[SolverService] Solve order: CP-SAT(slot+assignment) -> MILP(assignment) -> baseline");
    }

    const cpSat = tryRunCpSatPython(
      input,
      this.hardConstraints,
      this.softObjectives,
      this.timeoutSeconds,
      this.logSearch
    );
    if (cpSat && cpSat.raidSchedules.length > 0) {
      if (this.logSearch) {
        console.log("[SolverService] OR-Tools CP-SAT solution selected");
      }
      return cpSat;
    }

    const skeleton = this.buildSkeleton(input, options);
    const milp = optimizeAssignmentsMilp(input, skeleton, this.hardConstraints, this.softObjectives);
    if (milp) {
      if (this.logSearch) {
        console.log("[SolverService] MILP fallback solution selected");
      }
      return milp;
    }

    if (this.logSearch) {
      console.log("[SolverService] Baseline fallback solution selected");
    }

    return generateBaselineWeeklySchedule(input, {
      attempts: options?.attempts,
      seed: options?.seed,
      earlyStopNoImproveAttempts: options?.earlyStopNoImproveAttempts,
      onAttemptCompleted: options?.onAttemptCompleted
    });
  }

  validateHardConstraints(output: SchedulerOutput): { valid: boolean; violations: string[] } {
    const violations: string[] = [];

    for (const raidSchedule of output.raidSchedules) {
      if (raidSchedule.assignments.length > raidSchedule.raid.capacity) {
        violations.push(`Raid overbooked: ${raidSchedule.assignments.length} > ${raidSchedule.raid.capacity}`);
      }

      let supportCount = 0;
      let dpsCount = 0;
      for (const assignment of raidSchedule.assignments) {
        if (assignment.assignedRole === "Support") {
          supportCount += 1;
        } else {
          dpsCount += 1;
        }
      }

      const limits = roleCaps(raidSchedule.raid.capacity);
      if (supportCount > limits.maxSupport) {
        violations.push(`Too many supports: ${supportCount} > ${limits.maxSupport}`);
      }
      if (dpsCount > limits.maxDps) {
        violations.push(`Too many DPS: ${dpsCount} > ${limits.maxDps}`);
      }
    }

    return { valid: violations.length === 0, violations };
  }

  getConfig(): { hardConstraints: HardConstraints; softObjectives: SoftObjectives; timeoutSeconds: number } {
    return {
      hardConstraints: this.hardConstraints,
      softObjectives: this.softObjectives,
      timeoutSeconds: this.timeoutSeconds
    };
  }
}

export function createSolver(config?: SolverConfig): SolverService {
  return new SolverService(config);
}
