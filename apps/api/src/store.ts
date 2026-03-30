import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DataStoreSchema, type AvailabilityWindow, type Character, type DataStore, type Player, type RaidInstance } from "@las/shared";

const DEFAULT_STORE: DataStore = {
  players: [],
  characters: [],
  raids: [],
  availabilityWindows: []
};

export class Store {
  constructor(private readonly filePath: string) {}

  async load(): Promise<DataStore> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text);
      return DataStoreSchema.parse(parsed);
    } catch {
      await this.save(DEFAULT_STORE);
      return structuredClone(DEFAULT_STORE);
    }
  }

  async save(data: DataStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  async addPlayer(player: Player): Promise<Player> {
    const data = await this.load();
    data.players.push(player);
    await this.save(data);
    return player;
  }

  async updatePlayer(id: string, patch: { name?: string }): Promise<Player | null> {
    const data = await this.load();
    const index = data.players.findIndex((p) => p.id === id);
    if (index < 0) {
      return null;
    }

    const current = data.players[index];
    data.players[index] = {
      ...current,
      ...patch
    };
    await this.save(data);
    return data.players[index];
  }

  async deletePlayer(id: string): Promise<boolean> {
    const data = await this.load();
    const beforePlayers = data.players.length;
    data.players = data.players.filter((p) => p.id !== id);

    if (data.players.length === beforePlayers) {
      return false;
    }

    // Keep data consistent by removing child records for deleted players.
    data.characters = data.characters.filter((c) => c.playerId !== id);
    data.availabilityWindows = data.availabilityWindows.filter((w) => w.playerId !== id);
    await this.save(data);
    return true;
  }

  async addCharacter(character: Character): Promise<Character> {
    const data = await this.load();
    data.characters.push(character);
    await this.save(data);
    return character;
  }

  async updateCharacter(
    id: string,
    patch: {
      playerId?: string;
      name?: string;
      role?: Character["role"];
      itemLevel?: number;
      raidOptOutRaidIds?: string[];
    }
  ): Promise<Character | null> {
    const data = await this.load();
    const index = data.characters.findIndex((c) => c.id === id);
    if (index < 0) {
      return null;
    }

    const current = data.characters[index];
    data.characters[index] = {
      ...current,
      ...patch
    };
    await this.save(data);
    return data.characters[index];
  }

  async deleteCharacter(id: string): Promise<boolean> {
    const data = await this.load();
    const beforeCount = data.characters.length;
    data.characters = data.characters.filter((c) => c.id !== id);
    if (data.characters.length === beforeCount) {
      return false;
    }
    await this.save(data);
    return true;
  }

  async addRaid(raid: RaidInstance): Promise<RaidInstance> {
    const data = await this.load();
    data.raids.push(raid);
    await this.save(data);
    return raid;
  }

  async updateRaid(
    id: string,
    patch: {
      name?: string;
      difficulty?: RaidInstance["difficulty"];
      itemLevelRequirement?: number;
      durationMinutes?: number;
    }
  ): Promise<RaidInstance | null> {
    const data = await this.load();
    const index = data.raids.findIndex((r) => r.id === id);
    if (index < 0) {
      return null;
    }

    const current = data.raids[index];
    data.raids[index] = {
      ...current,
      ...patch
    };
    await this.save(data);
    return data.raids[index];
  }

  async deleteRaid(id: string): Promise<boolean> {
    const data = await this.load();
    const beforeCount = data.raids.length;
    data.raids = data.raids.filter((r) => r.id !== id);
    if (data.raids.length === beforeCount) {
      return false;
    }
    await this.save(data);
    return true;
  }

  async addAvailability(window: AvailabilityWindow): Promise<AvailabilityWindow> {
    const data = await this.load();
    data.availabilityWindows.push(window);
    await this.save(data);
    return window;
  }

  async updateAvailability(
    id: string,
    patch: {
      playerId?: string;
      dayOfWeek?: number;
      startMinute?: number;
      endMinute?: number;
    }
  ): Promise<AvailabilityWindow | null> {
    const data = await this.load();
    const index = data.availabilityWindows.findIndex((w) => w.id === id);
    if (index < 0) {
      return null;
    }

    const current = data.availabilityWindows[index];
    data.availabilityWindows[index] = {
      ...current,
      ...patch
    };
    await this.save(data);
    return data.availabilityWindows[index];
  }

  async deleteAvailability(id: string): Promise<boolean> {
    const data = await this.load();
    const beforeCount = data.availabilityWindows.length;
    data.availabilityWindows = data.availabilityWindows.filter((w) => w.id !== id);
    if (data.availabilityWindows.length === beforeCount) {
      return false;
    }
    await this.save(data);
    return true;
  }
}
