import express from "express";
import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AvailabilityWindowCreateSchema,
  CharacterCreateSchema,
  type DataStore,
  GenerateScheduleInputSchema,
  type ScheduleResult,
  RoleSchema,
  PlayerCreateSchema,
  RaidCreateSchema
} from "@las/shared";
import {
  generateWeeklySchedule,
  generateWeeklyScheduleWithEngine,
  compareSchedulerEngines,
  isScheduleQualityBetter,
  scoreScheduleQuality,
  type ScheduleQuality
} from "@las/scheduler";
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

const ScheduleGenerationOptionsSchema = z.object({
  data: GenerateScheduleInputSchema.optional(),
  attempts: z.number().int().min(1).max(5000).optional(),
  seed: z.number().int().min(0).max(4294967295).optional(),
  earlyStopNoImproveAttempts: z.number().int().min(1).max(5000).optional(),
  engine: z.enum(["heuristic", "solver", "hybrid"]).optional(),
  fallbackToHeuristic: z.boolean().optional(),
  compareWithHeuristic: z.boolean().optional()
});

type ScheduleProgressJob = {
  id: string;
  state: "running" | "completed" | "failed";
  attempts: number;
  completedAttempts: number;
  seed: number;
  engine: "heuristic" | "solver" | "hybrid";
  result?: ReturnType<typeof generateWeeklySchedule>;
  grid?: ReturnType<typeof toWeeklyGrid>;
  data?: DataStore;
  error?: string;
};

const scheduleProgressJobs = new Map<string, ScheduleProgressJob>();

const WORKER_HASH_STEP = 0x9e3779b9;

type WorkerDonePayload = {
  result: ScheduleResult;
  quality: ScheduleQuality;
};

function getWorkerCount(attempts: number): number {
  const cpuCount = Math.max(1, cpus().length || 1);
  return Math.max(1, Math.min(attempts, cpuCount));
}

async function generateWeeklyScheduleParallel(
  input: DataStore,
  attempts: number,
  seed: number,
  earlyStopNoImproveAttempts: number | undefined,
  onAttemptCompleted: (completedAttempts: number, totalAttempts: number) => void
): Promise<ScheduleResult> {
  const workerCount = getWorkerCount(attempts);

  if (workerCount <= 1 || attempts <= 1) {
    return generateWeeklySchedule(input, {
      attempts,
      seed,
      earlyStopNoImproveAttempts,
      onAttemptCompleted
    });
  }

  const baseChunk = Math.floor(attempts / workerCount);
  const remainder = attempts % workerCount;
  const chunks: number[] = [];
  for (let i = 0; i < workerCount; i += 1) {
    chunks.push(baseChunk + (i < remainder ? 1 : 0));
  }

  let globalBestResult: ScheduleResult | null = null;
  let globalBestQuality: ScheduleQuality | null = null;
  let totalCompletedAttempts = 0;
  let globalTargetAttempts = attempts;

  const workerScript = `
    const { parentPort, workerData } = require('node:worker_threads');

    (async () => {
      const { generateWeeklySchedule, scoreScheduleQuality } = await import('@las/scheduler');
      const { input, attempts, seed, earlyStopNoImproveAttempts } = workerData;

      const result = generateWeeklySchedule(input, {
        attempts,
        seed,
        earlyStopNoImproveAttempts,
        onAttemptCompleted: (completedAttempts, totalAttempts) => {
          parentPort.postMessage({ type: 'progress', completedAttempts, totalAttempts });
        }
      });

      const quality = scoreScheduleQuality(input, result);
      parentPort.postMessage({ type: 'done', result, quality });
    })().catch((error) => {
      parentPort.postMessage({ type: 'error', error: error && error.message ? error.message : String(error) });
    });
  `;

  await Promise.all(chunks.map((chunkAttempts, workerIndex) => new Promise<void>((resolve, reject) => {
    if (chunkAttempts <= 0) {
      resolve();
      return;
    }

    const workerSeed = (seed + Math.imul(workerIndex, WORKER_HASH_STEP)) >>> 0;
    const worker = new Worker(workerScript, {
      eval: true,
      workerData: {
        input,
        attempts: chunkAttempts,
        seed: workerSeed,
        earlyStopNoImproveAttempts
      }
    });

    let previousCompleted = 0;
    let workerTargetAttempts = chunkAttempts;

    worker.on("message", (message: unknown) => {
      const payload = message as {
        type?: string;
        completedAttempts?: number;
        totalAttempts?: number;
        error?: string;
        result?: ScheduleResult;
        quality?: ScheduleQuality;
      };

      if (payload.type === "progress") {
        const nextWorkerTarget = Math.max(1, Math.min(chunkAttempts, payload.totalAttempts ?? workerTargetAttempts));
        if (nextWorkerTarget !== workerTargetAttempts) {
          globalTargetAttempts += nextWorkerTarget - workerTargetAttempts;
          workerTargetAttempts = nextWorkerTarget;
          if (previousCompleted > workerTargetAttempts) {
            previousCompleted = workerTargetAttempts;
          }
        }

        const nextCompleted = Math.max(0, Math.min(workerTargetAttempts, payload.completedAttempts ?? 0));
        const delta = Math.max(0, nextCompleted - previousCompleted);
        previousCompleted = nextCompleted;
        if (delta > 0) {
          totalCompletedAttempts += delta;
          onAttemptCompleted(totalCompletedAttempts, globalTargetAttempts);
        }
        return;
      }

      if (payload.type === "done") {
        if (previousCompleted < workerTargetAttempts) {
          totalCompletedAttempts += workerTargetAttempts - previousCompleted;
          previousCompleted = workerTargetAttempts;
          onAttemptCompleted(totalCompletedAttempts, globalTargetAttempts);
        }

        if (!payload.result || !payload.quality) {
          reject(new Error("Worker returned incomplete schedule payload."));
          return;
        }

        const donePayload: WorkerDonePayload = {
          result: payload.result,
          quality: payload.quality
        };
        if (!globalBestResult || !globalBestQuality || isScheduleQualityBetter(donePayload.quality, globalBestQuality)) {
          globalBestResult = donePayload.result;
          globalBestQuality = donePayload.quality;
        }
      }

      if (payload.type === "error") {
        reject(new Error(payload.error || "Worker failed during schedule generation."));
      }
    });

    worker.on("error", (error) => {
      reject(error);
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Schedule worker exited with code ${code}.`));
        return;
      }
      resolve();
    });
  })));

  if (!globalBestResult || !globalBestQuality) {
    throw new Error("Parallel schedule generation produced no result.");
  }

  return globalBestResult;
}

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
  name: z.string().min(1).optional(),
  vip: z.boolean().optional()
}).refine((v) => v.name !== undefined || v.vip !== undefined, {
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
    const result = await generateWeeklyScheduleWithEngine(fromRequest.data, {
      engine: "hybrid"
    });
    return res.json(result);
  }

  const withOptions = ScheduleGenerationOptionsSchema.safeParse(req.body ?? {});
  if (withOptions.success) {
    const data = withOptions.data.data ?? (await store.load());
    const result = await generateWeeklyScheduleWithEngine(data, {
      attempts: withOptions.data.attempts,
      seed: withOptions.data.seed,
      earlyStopNoImproveAttempts: withOptions.data.earlyStopNoImproveAttempts,
      engine: withOptions.data.engine,
      fallbackToHeuristic: withOptions.data.fallbackToHeuristic,
      compareWithHeuristic: withOptions.data.compareWithHeuristic
    });
    return res.json(result);
  }

  if (req.body && Object.keys(req.body).length > 0) {
    return res.status(400).json({
      error: "Request body must be scheduler input data or options: attempts/seed (optional with optional data payload)."
    });
  }

  const data = await store.load();
  const result = await generateWeeklyScheduleWithEngine(data, {
    attempts: 1000,
    engine: "hybrid"
  });
  return res.json(result);
});

app.post("/schedules/generate-progress/start", async (req, res) => {
  const parsed = ScheduleGenerationOptionsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const payload = parsed.data;
  const data = payload.data ?? (await store.load());
  const attempts = payload.attempts ?? 1000;
  const seed = payload.seed ?? (Math.floor(Math.random() * 0x100000000) >>> 0);
  const earlyStopNoImproveAttempts = payload.earlyStopNoImproveAttempts;
  const engine = payload.engine ?? "hybrid";

  const jobId = randomUUID();
  const job: ScheduleProgressJob = {
    id: jobId,
    state: "running",
    attempts,
    completedAttempts: 0,
    seed,
    engine
  };
  scheduleProgressJobs.set(jobId, job);

  void (async () => {
    try {
      let result: ScheduleResult;

      if (engine === "heuristic") {
        result = await generateWeeklyScheduleParallel(
          data,
          attempts,
          seed,
          earlyStopNoImproveAttempts,
          (completedAttempts, totalAttempts) => {
            const current = scheduleProgressJobs.get(jobId);
            if (!current) {
              return;
            }
            current.completedAttempts = completedAttempts;
            current.attempts = totalAttempts;
          }
        );
      } else {
        result = await generateWeeklyScheduleWithEngine(data, {
          attempts,
          seed,
          earlyStopNoImproveAttempts,
          engine,
          fallbackToHeuristic: payload.fallbackToHeuristic,
          compareWithHeuristic: payload.compareWithHeuristic
        });
      }

      const current = scheduleProgressJobs.get(jobId);
      if (!current) {
        return;
      }

      current.result = result;
      current.data = data;
      current.grid = toWeeklyGrid(data, result, {});
      current.completedAttempts = current.attempts;
      current.state = "completed";
    } catch (error) {
      const current = scheduleProgressJobs.get(jobId);
      if (!current) {
        return;
      }
      current.state = "failed";
      current.error = error instanceof Error ? error.message : "Unknown schedule generation error.";
    }
  })();

  return res.json({
    jobId,
    attempts,
    seed,
    engine
  });
});

app.get("/schedules/generate-progress/:jobId", (req, res) => {
  const job = scheduleProgressJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Schedule generation job not found." });
  }

  return res.json({
    jobId: job.id,
    state: job.state,
    attempts: job.attempts,
    completedAttempts: job.completedAttempts,
    seed: job.seed,
    engine: job.engine,
    error: job.error,
    result: job.state === "completed" ? job.result : undefined,
    grid: job.state === "completed" ? job.grid : undefined,
    data: job.state === "completed" ? job.data : undefined
  });
});

app.post("/schedules/compare", async (req, res) => {
  const parsed = ScheduleGenerationOptionsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const payload = parsed.data;
  const data = payload.data ?? (await store.load());
  const comparison = await compareSchedulerEngines(data, {
    attempts: payload.attempts,
    seed: payload.seed,
    earlyStopNoImproveAttempts: payload.earlyStopNoImproveAttempts,
    fallbackToHeuristic: payload.fallbackToHeuristic,
    compareWithHeuristic: payload.compareWithHeuristic,
    engine: "hybrid"
  });

  return res.json(comparison);
});

const GenerateGridSchema = z.object({
  data: GenerateScheduleInputSchema.optional(),
  attempts: z.number().int().min(1).max(5000).optional(),
  seed: z.number().int().min(0).max(4294967295).optional(),
  earlyStopNoImproveAttempts: z.number().int().min(1).max(5000).optional(),
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
  const generated = await generateWeeklyScheduleWithEngine(data, {
    attempts: payload.attempts,
    seed: payload.seed,
    earlyStopNoImproveAttempts: payload.earlyStopNoImproveAttempts,
    engine: "hybrid"
  });

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
