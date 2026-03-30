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

  async addCharacter(character: Character): Promise<Character> {
    const data = await this.load();
    data.characters.push(character);
    await this.save(data);
    return character;
  }

  async addRaid(raid: RaidInstance): Promise<RaidInstance> {
    const data = await this.load();
    data.raids.push(raid);
    await this.save(data);
    return raid;
  }

  async addAvailability(window: AvailabilityWindow): Promise<AvailabilityWindow> {
    const data = await this.load();
    data.availabilityWindows.push(window);
    await this.save(data);
    return window;
  }
}
