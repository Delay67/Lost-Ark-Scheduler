/**
 * Scheduler Rules Engine
 * 
 * Separates business rules/eligibility checks from search/optimization logic.
 * These functions are pure and can be used by any scheduler engine.
 * They encode the constraints that must never be violated.
 */

import type {
  Character,
  RaidInstance,
  AvailabilityWindow,
  Role,
  PartySize,
  AssignedRole
} from "./index.js";

/**
 * Result of an eligibility check
 */
export type EligibilityResult = {
  eligible: boolean;
  violations: string[];
};

/**
 * Context for eligibility evaluation
 */
export type EligibilityContext = {
  /**
   * Raid capacity and role limits
   */
  raidCapacity: PartySize;
  roleLimits: { maxDps: number; maxSupport: number };
  
  /**
   * Current assignments for this raid (for capacity checks)
   */
  currentAssignments: Array<{
    characterId: string;
    playerId: string;
    assignedRole: AssignedRole;
  }>;
  
  /**
   * Characters already assigned in this raid
   */
  assignedCharacterIds: Set<string>;
  
  /**
   * Players already assigned in this raid (one per player max)
   */
  assignedPlayerIds: Set<string>;
  
  /**
   * Raid names already assigned to this character
   */
  assignedRaidNames: Set<string>;
  
  /**
   * Raid IDs already assigned to this character
   */
  assignedRaidIds: Set<string>;
  
  /**
   * Other time slots this player is scheduled for
   */
  playerScheduledSlots: Array<{
    dayOfWeek: number;
    startMinute: number;
    endMinute: number;
  }>;
};

/**
 * Check if a character meets the item level requirement for a raid
 */
export function checkItemLevelRequirement(
  character: Character,
  raid: RaidInstance
): EligibilityResult {
  if (character.itemLevel < raid.itemLevelRequirement) {
    return {
      eligible: false,
      violations: [
        `Character item level ${character.itemLevel} < required ${raid.itemLevelRequirement}`
      ]
    };
  }
  return { eligible: true, violations: [] };
}

/**
 * Check if character can take the required role
 */
export function checkRoleValidity(
  character: Character,
  neededRole: "DPS" | "Support"
): EligibilityResult {
  const characterRole = character.role;
  
  // DPS/Support can fill any role
  if (characterRole === "DPS/Support") {
    return { eligible: true, violations: [] };
  }
  
  // Other roles can only fill themselves
  if (characterRole === neededRole) {
    return { eligible: true, violations: [] };
  }
  
  return {
    eligible: false,
    violations: [`Character role ${characterRole} cannot fill ${neededRole}`]
  };
}

/**
 * Check if character has already been assigned to max raids (per-character cap)
 */
export function checkPerCharacterRaidCap(
  characterId: string,
  assignedRaidIds: Set<string>,
  maxRaidsPerCharacter: number = 3
): EligibilityResult {
  if (assignedRaidIds.size >= maxRaidsPerCharacter) {
    return {
      eligible: false,
      violations: [
        `Character already assigned to ${assignedRaidIds.size}/${maxRaidsPerCharacter} raids`
      ]
    };
  }
  return { eligible: true, violations: [] };
}

/**
 * Check if player is already in this raid (one per player max)
 */
export function checkNoPlayerOverlap(
  playerId: string,
  assignedPlayerIds: Set<string>
): EligibilityResult {
  if (assignedPlayerIds.has(playerId)) {
    return {
      eligible: false,
      violations: ["Player already assigned to this raid"]
    };
  }
  return { eligible: true, violations: [] };
}

/**
 * Check if this character already has a raid with the same name
 */
export function checkNoDuplicateRaidNames(
  raidName: string,
  assignedRaidNames: Set<string>
): EligibilityResult {
  const normalizedRaidName = raidName.trim().toLowerCase();
  
  // Build a set of normalized names for comparison
  const normalizedAssignedNames = new Set(
    Array.from(assignedRaidNames).map(n => n.trim().toLowerCase())
  );
  
  if (normalizedAssignedNames.has(normalizedRaidName)) {
    return {
      eligible: false,
      violations: [`Character already assigned to raid "${raidName}"`]
    };
  }
  return { eligible: true, violations: [] };
}

/**
 * Check if raid is not in character's opt-out list
 */
export function checkRaidNotOptedOut(
  raidId: string,
  raidOptOutIds: string[]
): EligibilityResult {
  if (raidOptOutIds.includes(raidId)) {
    return {
      eligible: false,
      violations: ["Character has opted out of this raid"]
    };
  }
  return { eligible: true, violations: [] };
}

/**
 * Check if there's a time conflict with existing player schedule
 */
export function checkNoTimeConflict(
  raidDayOfWeek: number,
  raidStartMinute: number,
  raidDurationMinutes: number,
  playerScheduledSlots: Array<{
    dayOfWeek: number;
    startMinute: number;
    endMinute: number;
  }>
): EligibilityResult {
  const raidEndMinute = raidStartMinute + raidDurationMinutes;
  
  for (const slot of playerScheduledSlots) {
    // Different day = no conflict
    if (slot.dayOfWeek !== raidDayOfWeek) {
      continue;
    }
    
    // Check for time overlap
    if (raidStartMinute < slot.endMinute && slot.startMinute < raidEndMinute) {
      return {
        eligible: false,
        violations: [
          `Time conflict with existing schedule on day ${raidDayOfWeek}: ` +
          `raid ${raidStartMinute}-${raidEndMinute} overlaps with ${slot.startMinute}-${slot.endMinute}`
        ]
      };
    }
  }
  
  return { eligible: true, violations: [] };
}

/**
 * Check if player has availability window covering the raid time
 */
export function checkAvailabilityCoverage(
  raidDayOfWeek: number,
  raidStartMinute: number,
  raidDurationMinutes: number,
  availabilityWindows: AvailabilityWindow[]
): EligibilityResult {
  const raidEndMinute = raidStartMinute + raidDurationMinutes;
  
  for (const window of availabilityWindows) {
    if (
      window.dayOfWeek === raidDayOfWeek &&
      window.startMinute <= raidStartMinute &&
      window.endMinute >= raidEndMinute
    ) {
      return { eligible: true, violations: [] };
    }
  }
  
  return {
    eligible: false,
    violations: [
      `No availability window covers raid on day ${raidDayOfWeek}: ${raidStartMinute}-${raidEndMinute}`
    ]
  };
}

/**
 * Check if raid is not at capacity
 */
export function checkRaidNotAtCapacity(
  currentAssignmentCount: number,
  capacity: PartySize
): EligibilityResult {
  if (currentAssignmentCount >= capacity) {
    return {
      eligible: false,
      violations: [`Raid already at capacity (${currentAssignmentCount}/${capacity})`]
    };
  }
  return { eligible: true, violations: [] };
}

/**
 * Check if role slot is still available
 */
export function checkRoleSlotAvailable(
  neededRole: AssignedRole,
  currentAssignments: Array<{ assignedRole: AssignedRole }>,
  roleLimit: number
): EligibilityResult {
  const currentCount = currentAssignments.filter(
    a => a.assignedRole === neededRole
  ).length;
  
  if (currentCount >= roleLimit) {
    return {
      eligible: false,
      violations: [
        `${neededRole} slots full (${currentCount}/${roleLimit})`
      ]
    };
  }
  return { eligible: true, violations: [] };
}

/**
 * Run all hard constraint checks
 * Returns combined result with all violations
 */
export function checkAllHardConstraints(
  character: Character,
  raid: RaidInstance,
  neededRole: "DPS" | "Support",
  context: EligibilityContext,
  availabilityWindows: AvailabilityWindow[],
  maxRaidsPerCharacter: number = 3
): EligibilityResult {
  const checks: EligibilityResult[] = [
    checkItemLevelRequirement(character, raid),
    checkRoleValidity(character, neededRole),
    checkPerCharacterRaidCap(character.id, context.assignedRaidIds, maxRaidsPerCharacter),
    checkNoPlayerOverlap(character.playerId, context.assignedPlayerIds),
    checkNoDuplicateRaidNames(raid.name, context.assignedRaidNames),
    checkRaidNotOptedOut(raid.id, character.raidOptOutRaidIds ?? []),
    checkRaidNotAtCapacity(context.currentAssignments.length, context.raidCapacity),
    checkRoleSlotAvailable(neededRole, context.currentAssignments, 
      neededRole === "DPS" ? context.roleLimits.maxDps : context.roleLimits.maxSupport)
  ];
  
  const allViolations = checks.flatMap(c => c.violations);
  
  return {
    eligible: allViolations.length === 0,
    violations: allViolations
  };
}

/**
 * Run all checks with actual raid slot values
 */
export function checkCharacterEligibility(
  character: Character,
  raid: RaidInstance,
  raidSlot: { dayOfWeek: number; startMinute: number },
  neededRole: "DPS" | "Support",
  context: EligibilityContext,
  availabilityWindows: AvailabilityWindow[],
  maxRaidsPerCharacter: number = 3
): EligibilityResult {
  const violations: string[] = [];
  
  // Check each constraint
  violations.push(
    ...checkItemLevelRequirement(character, raid).violations
  );
  violations.push(
    ...checkRoleValidity(character, neededRole).violations
  );
  violations.push(
    ...checkPerCharacterRaidCap(character.id, context.assignedRaidIds, maxRaidsPerCharacter).violations
  );
  violations.push(
    ...checkNoPlayerOverlap(character.playerId, context.assignedPlayerIds).violations
  );
  violations.push(
    ...checkNoDuplicateRaidNames(raid.name, context.assignedRaidNames).violations
  );
  violations.push(
    ...checkRaidNotOptedOut(raid.id, character.raidOptOutRaidIds ?? []).violations
  );
  
  // Time-based checks need the actual slot
  const playerWindowsForDay = availabilityWindows.filter(
    w => w.playerId === character.playerId
  );
  violations.push(
    ...checkAvailabilityCoverage(
      raidSlot.dayOfWeek,
      raidSlot.startMinute,
      raid.durationMinutes,
      playerWindowsForDay
    ).violations
  );
  violations.push(
    ...checkNoTimeConflict(
      raidSlot.dayOfWeek,
      raidSlot.startMinute,
      raid.durationMinutes,
      context.playerScheduledSlots
    ).violations
  );
  
  violations.push(
    ...checkRaidNotAtCapacity(context.currentAssignments.length, context.raidCapacity).violations
  );
  violations.push(
    ...checkRoleSlotAvailable(neededRole, context.currentAssignments,
      neededRole === "DPS" ? context.roleLimits.maxDps : context.roleLimits.maxSupport
    ).violations
  );
  
  return {
    eligible: violations.length === 0,
    violations
  };
}
