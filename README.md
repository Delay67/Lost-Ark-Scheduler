# Lost Ark Scheduler

This repository now contains the first implementation slice of a weekly raid scheduler for Lost Ark.

## Current implementation

- TypeScript monorepo with npm workspaces.
- Express API for data entry and schedule generation.
- Shared domain schema package with Zod validation.
- Scheduler engine package with fill-first assignment and deadtime-aware candidate selection.
- JSON-backed local persistence for quick iteration.

## Requirements covered in this slice

- Store player names.
- Store characters under players.
- Character item level and role (`DPS`, `Support`, `DPS/Support`).
- Store raids with name, difficulty (`Normal`, `Hard`, `Nightmare`), and item level requirement.
- Store player recurring weekly availability windows by day and time range.
- Raid capacity support for 4 and 8 players.
- Per-raid customizable duration.
- Role caps enforced:
	- 8-player raids: max 6 DPS, max 2 Supports.
	- 4-player raids: max 3 DPS, max 1 Support.
- Scheduler objective in this version:
	- Primary: fill raids as much as possible with valid assignments.
	- Secondary: reduce downtime by preferring contiguous assignments for each player.
- Week processing order defaults to Wednesday as the first day.

## Project structure

- `apps/api`: Express API and local JSON store.
- `packages/shared`: domain models and schemas.
- `packages/scheduler`: scheduling engine.

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Start API:

```bash
npm run dev
```

3. Health check:

```bash
GET http://localhost:3000/health
```

## API endpoints

### Create player

`POST /players`

```json
{
	"name": "Player 1"
}
```

### Create character

`POST /characters`

```json
{
	"playerId": "<player-id>",
	"name": "Main Bard",
	"role": "DPS/Support",
	"itemLevel": 1660
}
```

### Create raid

`POST /raids`

```json
{
	"name": "Thaemine G1-G3",
	"difficulty": "Hard",
	"itemLevelRequirement": 1630,
	"capacity": 8,
	"dayOfWeek": 2,
	"startMinute": 1140,
	"durationMinutes": 90
}
```

`dayOfWeek` uses `0-6` (`0 = Sunday`).

`startMinute` is minutes since midnight (`19:00 => 1140`).

### Create availability window

`POST /availability-windows`

```json
{
	"playerId": "<player-id>",
	"dayOfWeek": 2,
	"startMinute": 1080,
	"endMinute": 1380
}
```

### Generate schedule

`POST /schedules/generate`

- Empty body uses persisted store data.
- Full body can be provided with:
	- `players`
	- `characters`
	- `raids`
	- `availabilityWindows`

Response includes:

- Raid-by-raid assignments.
- Underfilled raid IDs.
- Deadtime summary per player.

### Generate spreadsheet-like weekly grid

`POST /schedules/grid`

This returns a sheet-style structure grouped by day with:

- `notes`
- `time`
- `day`
- `raid`
- core player columns
- `extras`
- `supports` (character names for assigned support slots)
- `count`

Example request with custom player columns:

```json
{
	"corePlayerOrder": ["Delay", "Marcel", "Nona", "Faal", "Wish", "Ghonty", "Vierazy", "Mawino", "Mina", "Phil"],
	"weekStartDay": 3
}
```

`weekStartDay = 3` means Wednesday-first.

## Notes

- This is an implementation start, not final production architecture.
- Storage is file-based (`apps/api/data/store.json` when run from repo root, equivalent runtime location `apps/api/data/store.json`) for fast prototyping.
- Next implementation steps are database migrations, auth/roles, frontend planner UI, and deeper optimization passes for deadtime.