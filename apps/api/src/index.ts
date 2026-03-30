import express from "express";
import {
  AvailabilityWindowCreateSchema,
  CharacterCreateSchema,
  GenerateScheduleInputSchema,
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

const store = new Store("data/store.json");

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/data", async (_req, res) => {
  const data = await store.load();
  res.json(data);
});

app.post("/players", async (req, res) => {
  const parsed = PlayerCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const created = await store.addPlayer({ id: newId(), ...parsed.data });
  return res.status(201).json(created);
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

app.post("/raids", async (req, res) => {
  const parsed = RaidCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const created = await store.addRaid({ id: newId(), ...parsed.data });
  return res.status(201).json(created);
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
