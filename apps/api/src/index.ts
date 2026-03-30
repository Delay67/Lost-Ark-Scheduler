import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AvailabilityWindowCreateSchema,
  CharacterCreateSchema,
  GenerateScheduleInputSchema,
  RoleSchema,
  PlayerCreateSchema,
  RaidCreateSchema
} from "@las/shared";
import { generateWeeklySchedule } from "@las/scheduler";
import { z } from "zod";
import { toWeeklyGrid } from "./grid.js";
import { newId } from "./ids.js";
import { Store } from "./store.js";

const app = express();
app.use(express.json());

const fileName = fileURLToPath(import.meta.url);
const dirName = dirname(fileName);
app.use(express.static(join(dirName, "../public")));

const store = new Store("data/store.json");

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/data", async (_req, res) => {
  const data = await store.load();
  res.json(data);
});

app.get("/players", async (_req, res) => {
  const data = await store.load();
  res.json(data.players);
});

app.post("/players", async (req, res) => {
  const parsed = PlayerCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const created = await store.addPlayer({ id: newId(), ...parsed.data });
  return res.status(201).json(created);
});

const PlayerUpdateSchema = z.object({
  name: z.string().min(1).optional()
}).refine((v) => v.name !== undefined, {
  message: "At least one field must be provided"
});

app.patch("/players/:id", async (req, res) => {
  const parsed = PlayerUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const updated = await store.updatePlayer(req.params.id, parsed.data);
  if (!updated) {
    return res.status(404).json({ error: "Player not found" });
  }

  return res.json(updated);
});

app.delete("/players/:id", async (req, res) => {
  const deleted = await store.deletePlayer(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: "Player not found" });
  }
  return res.status(204).send();
});

app.get("/characters", async (_req, res) => {
  const data = await store.load();
  res.json(data.characters);
});

app.post("/characters", async (req, res) => {
  const parsed = CharacterCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const data = await store.load();
  const playerExists = data.players.some((p) => p.id === parsed.data.playerId);
  if (!playerExists) {
    return res.status(400).json({ error: "playerId does not exist" });
  }

  const created = await store.addCharacter({ id: newId(), ...parsed.data });
  return res.status(201).json(created);
});

const CharacterUpdateSchema = z.object({
  playerId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  role: RoleSchema.optional(),
  itemLevel: z.number().int().positive().optional(),
  raidOptOutRaidIds: z.array(z.string().min(1)).optional()
}).refine((v) => Object.keys(v).length > 0, {
  message: "At least one field must be provided"
});

app.patch("/characters/:id", async (req, res) => {
  const parsed = CharacterUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  if (parsed.data.playerId) {
    const data = await store.load();
    const playerExists = data.players.some((p) => p.id === parsed.data.playerId);
    if (!playerExists) {
      return res.status(400).json({ error: "playerId does not exist" });
    }
  }

  const updated = await store.updateCharacter(req.params.id, parsed.data);
  if (!updated) {
    return res.status(404).json({ error: "Character not found" });
  }

  return res.json(updated);
});

app.delete("/characters/:id", async (req, res) => {
  const deleted = await store.deleteCharacter(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: "Character not found" });
  }
  return res.status(204).send();
});

app.post("/raids", async (req, res) => {
  const parsed = RaidCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const created = await store.addRaid({ id: newId(), ...parsed.data });
  return res.status(201).json(created);
});

app.get("/raids", async (_req, res) => {
  const data = await store.load();
  return res.json(data.raids);
});

const RaidUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  difficulty: z.enum(["Normal", "Hard", "Nightmare"]).optional(),
  itemLevelRequirement: z.number().int().positive().optional(),
  durationMinutes: z.number().int().positive().max(24 * 60).optional()
}).refine((v) => Object.keys(v).length > 0, {
  message: "At least one field must be provided"
});

app.patch("/raids/:id", async (req, res) => {
  const parsed = RaidUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const updated = await store.updateRaid(req.params.id, parsed.data);
  if (!updated) {
    return res.status(404).json({ error: "Raid not found" });
  }

  return res.json(updated);
});

app.delete("/raids/:id", async (req, res) => {
  const deleted = await store.deleteRaid(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: "Raid not found" });
  }
  return res.status(204).send();
});

app.post("/availability-windows", async (req, res) => {
  const parsed = AvailabilityWindowCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const data = await store.load();
  const playerExists = data.players.some((p) => p.id === parsed.data.playerId);
  if (!playerExists) {
    return res.status(400).json({ error: "playerId does not exist" });
  }

  const created = await store.addAvailability({ id: newId(), ...parsed.data });
  return res.status(201).json(created);
});

app.get("/availability-windows", async (_req, res) => {
  const data = await store.load();
  return res.json(data.availabilityWindows);
});

const AvailabilityUpdateSchema = z.object({
  playerId: z.string().min(1).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  startMinute: z.number().int().min(0).max(24 * 60 - 1).optional(),
  endMinute: z.number().int().min(1).max(24 * 60).optional()
}).refine((v) => Object.keys(v).length > 0, {
  message: "At least one field must be provided"
});

app.patch("/availability-windows/:id", async (req, res) => {
  const parsed = AvailabilityUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const currentData = await store.load();
  const current = currentData.availabilityWindows.find((w) => w.id === req.params.id);
  if (!current) {
    return res.status(404).json({ error: "Availability window not found" });
  }

  const merged = { ...current, ...parsed.data };
  const validMerged = AvailabilityWindowCreateSchema.safeParse({
    playerId: merged.playerId,
    dayOfWeek: merged.dayOfWeek,
    startMinute: merged.startMinute,
    endMinute: merged.endMinute
  });

  if (!validMerged.success) {
    return res.status(400).json({ error: validMerged.error.flatten() });
  }

  const playerExists = currentData.players.some((p) => p.id === merged.playerId);
  if (!playerExists) {
    return res.status(400).json({ error: "playerId does not exist" });
  }

  const updated = await store.updateAvailability(req.params.id, parsed.data);
  if (!updated) {
    return res.status(404).json({ error: "Availability window not found" });
  }

  return res.json(updated);
});

app.delete("/availability-windows/:id", async (req, res) => {
  const deleted = await store.deleteAvailability(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: "Availability window not found" });
  }
  return res.status(204).send();
});

app.post("/schedules/generate", async (req, res) => {
  const fromRequest = GenerateScheduleInputSchema.safeParse(req.body);

  if (fromRequest.success) {
    return res.json(generateWeeklySchedule(fromRequest.data));
  }

  if (req.body && Object.keys(req.body).length > 0) {
    return res.status(400).json({
      error: "If request body is provided, it must contain players, characters, raids, and availabilityWindows"
    });
  }

  const data = await store.load();
  return res.json(generateWeeklySchedule(data));
});

const GenerateGridSchema = z.object({
  data: GenerateScheduleInputSchema.optional(),
  corePlayerOrder: z.array(z.string().min(1)).optional(),
  weekStartDay: z.number().int().min(0).max(6).optional()
});

app.post("/schedules/grid", async (req, res) => {
  const parsed = GenerateGridSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const payload = parsed.data;
  const data = payload.data ?? (await store.load());
  const generated = generateWeeklySchedule(data);

  return res.json(
    toWeeklyGrid(data, generated, {
      corePlayerOrder: payload.corePlayerOrder,
      weekStartDay: payload.weekStartDay
    })
  );
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});
