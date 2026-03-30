import json
import sys


SLOT_STEP_MINUTES = 20
MAX_CANDIDATE_SLOTS_PER_RAID = 80


def normalize_raid_name(name: str) -> str:
    return name.strip().lower()


def overlaps(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    return a_start < b_end and b_start < a_end


def can_take_role(character_role: str, needed_role: str) -> bool:
    return character_role == "DPS/Support" or character_role == needed_role


def party_size_for_raid(raid: dict) -> int:
    name = normalize_raid_name(raid.get("name", ""))
    if "kayangel" in name or "ivory" in name or "voldis" in name:
        return 4
    return 8


def role_caps(capacity: int) -> tuple[int, int]:
    if capacity == 8:
        return 6, 2
    return 3, 1


def build_candidate_slots(input_data: dict, raid: dict) -> list[tuple[int, int]]:
    duration = int(raid["durationMinutes"])
    seen = set()
    slots = []
    for window in input_data["availabilityWindows"]:
        latest_start = int(window["endMinute"]) - duration
        if latest_start < int(window["startMinute"]):
            continue
        for start in range(int(window["startMinute"]), latest_start + 1, SLOT_STEP_MINUTES):
            key = (int(window["dayOfWeek"]), int(start))
            if key in seen:
                continue
            seen.add(key)
            slots.append(key)

    slots.sort(key=lambda x: (x[0], x[1]))
    if len(slots) > MAX_CANDIDATE_SLOTS_PER_RAID:
        return slots[:MAX_CANDIDATE_SLOTS_PER_RAID]
    return slots


def has_availability(input_data: dict, player_id: str, day_of_week: int, start_minute: int, duration: int) -> bool:
    end_minute = start_minute + duration
    for window in input_data["availabilityWindows"]:
        if window["playerId"] != player_id:
            continue
        if int(window["dayOfWeek"]) != day_of_week:
            continue
        if int(window["startMinute"]) <= start_minute and int(window["endMinute"]) >= end_minute:
            return True
    return False


def build_required_by_character(input_data: dict, max_raids: int) -> dict[str, set[str]]:
    raids = sorted(input_data["raids"], key=lambda r: (-int(r["itemLevelRequirement"]), r["id"]))
    required = {}
    for character in input_data["characters"]:
        seen_names = set()
        required_ids = set()
        opted_out = set(character.get("raidOptOutRaidIds", []))

        for raid in raids:
            if int(character["itemLevel"]) < int(raid["itemLevelRequirement"]):
                continue
            raid_name_key = normalize_raid_name(raid["name"])
            if raid_name_key in seen_names:
                continue
            seen_names.add(raid_name_key)
            if raid["id"] not in opted_out:
                required_ids.add(raid["id"])
            if len(required_ids) >= max_raids:
                break

        required[character["id"]] = required_ids

    return required


def summarize_deadtime(raid_schedules: list[dict]) -> list[dict]:
    slots_by_player: dict[str, list[tuple[int, int, int]]] = {}

    for raid_schedule in raid_schedules:
        raid = raid_schedule["raid"]
        end_minute = int(raid["startMinute"]) + int(raid["durationMinutes"])
        for assignment in raid_schedule["assignments"]:
            slots_by_player.setdefault(assignment["playerId"], []).append(
                (int(raid["dayOfWeek"]), int(raid["startMinute"]), end_minute)
            )

    summaries = []
    for player_id, slots in slots_by_player.items():
        slots.sort(key=lambda s: (s[0], s[1]))
        total_gap = 0
        largest_gap = 0

        for idx in range(1, len(slots)):
            prev = slots[idx - 1]
            cur = slots[idx]
            if cur[0] != prev[0]:
                continue
            gap = max(0, cur[1] - prev[2])
            total_gap += gap
            largest_gap = max(largest_gap, gap)

        summaries.append(
            {
                "playerId": player_id,
                "totalGapMinutes": total_gap,
                "largestGapMinutes": largest_gap,
                "assignmentCount": len(slots),
            }
        )

    summaries.sort(key=lambda s: s["playerId"])
    return summaries


def solve(payload: dict) -> dict:
    try:
        from ortools.sat.python import cp_model
    except Exception as ex:
        return {"status": "error", "error": f"ortools import failed: {ex}"}

    input_data = payload["input"]
    hard = payload["hardConstraints"]
    soft = payload["softObjectives"]
    timeout_seconds = float(payload.get("timeoutSeconds", 30))

    players_by_id = {p["id"]: p for p in input_data["players"]}
    max_raids_per_character = int(hard.get("maxRaidsPerCharacter", 3))
    required_by_character = build_required_by_character(input_data, max_raids_per_character)

    raids = input_data["raids"]
    model = cp_model.CpModel()

    # y vars: raid r scheduled at slot s
    y = {}
    # x vars: character assigned to raid-slot-role
    x = {}

    # metadata for x
    x_meta = {}

    slots_by_raid = {}
    for r_idx, raid in enumerate(raids):
        slots = build_candidate_slots(input_data, raid)
        slots_by_raid[r_idx] = slots
        for s_idx, _slot in enumerate(slots):
            y[(r_idx, s_idx)] = model.NewBoolVar(f"y_{r_idx}_{s_idx}")

    # at most one slot per raid template
    for r_idx, _raid in enumerate(raids):
        y_vars = [y[(r_idx, s_idx)] for s_idx in range(len(slots_by_raid[r_idx]))]
        if y_vars:
            model.Add(sum(y_vars) <= 1)

    # build x vars by eligibility
    for r_idx, raid in enumerate(raids):
        duration = int(raid["durationMinutes"])
        for s_idx, slot in enumerate(slots_by_raid[r_idx]):
            day_of_week, start_minute = slot
            for character in input_data["characters"]:
                if hard.get("itemLevelRequirements", True) and int(character["itemLevel"]) < int(raid["itemLevelRequirement"]):
                    continue
                if raid["id"] in set(character.get("raidOptOutRaidIds", [])):
                    continue
                if hard.get("respectAvailability", True) and not has_availability(
                    input_data,
                    character["playerId"],
                    day_of_week,
                    start_minute,
                    duration,
                ):
                    continue

                for role in ["DPS", "Support"]:
                    if hard.get("roleRequirements", True) and not can_take_role(character["role"], role):
                        continue
                    key = (r_idx, s_idx, character["id"], role)
                    x[key] = model.NewBoolVar(f"x_{r_idx}_{s_idx}_{character['id']}_{role}")
                    x_meta[key] = {
                        "raidIndex": r_idx,
                        "slotIndex": s_idx,
                        "characterId": character["id"],
                        "playerId": character["playerId"],
                        "role": role,
                    }
                    # assignment requires slot selected
                    model.Add(x[key] <= y[(r_idx, s_idx)])

    # raid-slot capacity and role caps
    for r_idx, raid in enumerate(raids):
        capacity = party_size_for_raid(raid)
        max_dps, max_support = role_caps(capacity)
        for s_idx, _slot in enumerate(slots_by_raid[r_idx]):
            slot_vars = [var for key, var in x.items() if key[0] == r_idx and key[1] == s_idx]
            model.Add(sum(slot_vars) <= capacity)

            support_vars = [var for key, var in x.items() if key[0] == r_idx and key[1] == s_idx and key[3] == "Support"]
            dps_vars = [var for key, var in x.items() if key[0] == r_idx and key[1] == s_idx and key[3] == "DPS"]
            model.Add(sum(support_vars) <= max_support)
            model.Add(sum(dps_vars) <= max_dps)

            # one character per player per raid-slot
            for player in input_data["players"]:
                player_vars = [
                    var
                    for key, var in x.items()
                    if key[0] == r_idx and key[1] == s_idx and x_meta[key]["playerId"] == player["id"]
                ]
                model.Add(sum(player_vars) <= 1)

    # per-character max raids
    for character in input_data["characters"]:
        char_vars = [var for key, var in x.items() if x_meta[key]["characterId"] == character["id"]]
        model.Add(sum(char_vars) <= max_raids_per_character)

    # no duplicate raid names per character
    if hard.get("noDuplicateRaidNames", True):
        raid_name_by_index = {idx: normalize_raid_name(raid["name"]) for idx, raid in enumerate(raids)}
        all_names = set(raid_name_by_index.values())
        for character in input_data["characters"]:
            for raid_name in all_names:
                vars_for_name = [
                    var
                    for key, var in x.items()
                    if x_meta[key]["characterId"] == character["id"] and raid_name_by_index[x_meta[key]["raidIndex"]] == raid_name
                ]
                model.Add(sum(vars_for_name) <= 1)

    # no overlapping assignments for each player
    if hard.get("noTimeConflicts", True):
        keys_by_player: dict[str, list[tuple]] = {}
        for key in x.keys():
            player_id = x_meta[key]["playerId"]
            keys_by_player.setdefault(player_id, []).append(key)

        for _player_id, keys in keys_by_player.items():
            for i in range(len(keys)):
                key_a = keys[i]
                meta_a = x_meta[key_a]
                raid_a = raids[meta_a["raidIndex"]]
                slot_a = slots_by_raid[meta_a["raidIndex"]][meta_a["slotIndex"]]
                a_day = slot_a[0]
                a_start = slot_a[1]
                a_end = a_start + int(raid_a["durationMinutes"])

                for j in range(i + 1, len(keys)):
                    key_b = keys[j]
                    meta_b = x_meta[key_b]
                    raid_b = raids[meta_b["raidIndex"]]
                    slot_b = slots_by_raid[meta_b["raidIndex"]][meta_b["slotIndex"]]
                    b_day = slot_b[0]
                    b_start = slot_b[1]
                    b_end = b_start + int(raid_b["durationMinutes"])

                    if a_day != b_day:
                        continue
                    if not overlaps(a_start, a_end, b_start, b_end):
                        continue
                    model.Add(x[key_a] + x[key_b] <= 1)

    # objective
    objective_terms = []
    for key, var in x.items():
        meta = x_meta[key]
        character_id = meta["characterId"]
        player_id = meta["playerId"]
        raid = raids[meta["raidIndex"]]

        is_required = raid["id"] in required_by_character.get(character_id, set())
        is_vip = bool(players_by_id[player_id].get("vip", False))

        score = 10
        if is_required:
            score += int(soft.get("fillRequiredWeight", 100))
        if is_required and is_vip:
            score += int(soft.get("priorityWeight", 1000))

        objective_terms.append(score * var)

    model.Maximize(sum(objective_terms))

    cp = cp_model.CpSolver()
    cp.parameters.max_time_in_seconds = timeout_seconds
    cp.parameters.num_search_workers = 8

    status = cp.Solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        status_name = "infeasible" if status == cp_model.INFEASIBLE else "unknown"
        return {"status": status_name, "error": "no feasible cp-sat solution"}

    raid_schedules = []
    seen_raid_ids = set()

    for r_idx, raid in enumerate(raids):
        selected_slot = None
        for s_idx in range(len(slots_by_raid[r_idx])):
            if cp.Value(y[(r_idx, s_idx)]) == 1:
                selected_slot = s_idx
                break

        if selected_slot is None:
            continue

        day_of_week, start_minute = slots_by_raid[r_idx][selected_slot]
        capacity = party_size_for_raid(raid)

        assignments = []
        for key, var in x.items():
            if cp.Value(var) != 1:
                continue
            if key[0] != r_idx or key[1] != selected_slot:
                continue
            meta = x_meta[key]
            assignments.append(
                {
                    "raidId": raid["id"],
                    "characterId": meta["characterId"],
                    "playerId": meta["playerId"],
                    "assignedRole": meta["role"],
                }
            )

        is_full = len(assignments) == capacity
        raid_schedules.append(
            {
                "raid": {
                    **raid,
                    "dayOfWeek": day_of_week,
                    "startMinute": start_minute,
                    "capacity": capacity,
                },
                "assignments": assignments,
                "isFull": is_full,
                "warnings": [] if is_full else [
                    f"Raid underfilled: assigned {len(assignments)}/{capacity}. Up to 2 slots remain reserved for supports."
                ],
            }
        )
        seen_raid_ids.add(raid["id"])

    # unscheduled raids and underfilled raids are unassigned
    unassigned = set(r["id"] for r in raids if r["id"] not in seen_raid_ids)
    for rs in raid_schedules:
        if not rs["isFull"]:
            unassigned.add(rs["raid"]["id"])

    raid_schedules.sort(key=lambda rs: (int(rs["raid"]["dayOfWeek"]), int(rs["raid"]["startMinute"]), rs["raid"]["id"]))

    result = {
        "raidSchedules": raid_schedules,
        "unassignedRaidIds": sorted(list(unassigned)),
        "playerDeadtime": summarize_deadtime(raid_schedules),
    }

    return {
        "status": "optimal" if status == cp_model.OPTIMAL else "feasible",
        "result": result,
    }


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
    except Exception as ex:
        print(json.dumps({"status": "error", "error": f"invalid input: {ex}"}))
        return

    output = solve(payload)
    print(json.dumps(output))


if __name__ == "__main__":
    main()
