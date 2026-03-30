const statusEl = document.getElementById("status");
const playersTable = document.getElementById("players-table");
const charactersTable = document.getElementById("characters-table");
const raidsTable = document.getElementById("raids-table");
const availabilityTable = document.getElementById("availability-table");
const scheduleGrid = document.getElementById("schedule-grid");
const generateScheduleButton = document.getElementById("generate-schedule");
const characterPlayerSelect = document.getElementById("character-player");
const availabilityPlayerSelect = document.getElementById("availability-player");

const playerForm = document.getElementById("player-form");
const characterForm = document.getElementById("character-form");
const raidForm = document.getElementById("raid-form");
const availabilityForm = document.getElementById("availability-form");

const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
let latestCharacters = [];
let latestRaids = [];
let latestPlayers = [];
let currentGridModel = null;
let activeDrag = null;

const tabButtons = [...document.querySelectorAll("[data-tab-target]")];
const tabPanels = [...document.querySelectorAll("[data-tab]")];

for (const button of tabButtons) {
  button.addEventListener("click", () => {
    const target = button.dataset.tabTarget;
    for (const b of tabButtons) {
      b.classList.toggle("is-active", b === button);
    }
    for (const panel of tabPanels) {
      panel.classList.toggle("is-active", panel.dataset.tab === target);
    }
  });
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b11" : "#064";
}

function normalizeDisplayText(value) {
  const text = String(value ?? "");
  if (!/[ÃÂâ]/.test(text)) {
    return text;
  }

  try {
    return decodeURIComponent(escape(text));
  } catch {
    return text;
  }
}

function normalizeLookupKey(value) {
  return normalizeDisplayText(value).trim().toLowerCase();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function buildPlayerSelect(players) {
  characterPlayerSelect.innerHTML = "";
  availabilityPlayerSelect.innerHTML = "";
  for (const player of players) {
    const option = document.createElement("option");
    option.value = player.id;
    option.textContent = normalizeDisplayText(player.name);
    characterPlayerSelect.append(option);

    const optionAvailability = document.createElement("option");
    optionAvailability.value = player.id;
    optionAvailability.textContent = normalizeDisplayText(player.name);
    availabilityPlayerSelect.append(optionAvailability);
  }
}

function renderPlayers(players) {
  playersTable.innerHTML = "";
  for (const player of players) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${normalizeDisplayText(player.name)}</td>
      <td>${player.id}</td>
      <td>
        <button data-action="edit-player" data-id="${player.id}" data-name="${player.name}">Edit</button>
        <button data-action="delete-player" data-id="${player.id}">Delete</button>
      </td>
    `;
    playersTable.append(row);
  }
}

function normalizeRaidName(name) {
  return String(name).trim().toLowerCase();
}

function getTopThreeRaidsForCharacter(character, raids) {
  const sortedRaids = [...raids].sort((a, b) => {
    if (b.itemLevelRequirement !== a.itemLevelRequirement) {
      return b.itemLevelRequirement - a.itemLevelRequirement;
    }
    return a.id.localeCompare(b.id);
  });

  const top = [];
  const seenNames = new Set();

  for (const raid of sortedRaids) {
    if (character.itemLevel < raid.itemLevelRequirement) {
      continue;
    }
    const nameKey = normalizeRaidName(raid.name);
    if (seenNames.has(nameKey)) {
      continue;
    }

    seenNames.add(nameKey);
    top.push(raid);
    if (top.length >= 3) {
      break;
    }
  }

  return top;
}

function renderCharacters(characters, playersById, raids) {
  charactersTable.innerHTML = "";
  for (const character of characters) {
    const topRaids = getTopThreeRaidsForCharacter(character, raids);
    const optOut = new Set(character.raidOptOutRaidIds ?? []);
    const topRaidsHtml = topRaids.length > 0
      ? `<div class="raid-opt-list">${topRaids
        .map((raid) => {
          const checked = !optOut.has(raid.id);
          return `<label class="raid-opt-item"><input type="checkbox" data-action="toggle-raid-optout" data-character-id="${character.id}" data-raid-id="${raid.id}" ${checked ? "checked" : ""}/> ${escapeHtml(normalizeDisplayText(`${raid.name}-${raid.difficulty}`))}</label>`;
        })
        .join("")}</div>`
      : `<span class="raid-opt-empty">No eligible raids</span>`;

    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${normalizeDisplayText(character.name)}</td>
      <td>${normalizeDisplayText(playersById.get(character.playerId) ?? character.playerId)}</td>
      <td>${character.role}</td>
      <td>${character.itemLevel}</td>
      <td>${topRaidsHtml}</td>
      <td>${character.id}</td>
      <td>
        <button
          data-action="edit-character"
          data-id="${character.id}"
          data-name="${character.name}"
          data-player-id="${character.playerId}"
          data-role="${character.role}"
          data-ilvl="${character.itemLevel}"
        >Edit</button>
        <button data-action="delete-character" data-id="${character.id}">Delete</button>
      </td>
    `;
    charactersTable.append(row);
  }
}

function renderRaids(raids) {
  raidsTable.innerHTML = "";
  for (const raid of raids) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${raid.name}</td>
      <td>${raid.difficulty}</td>
      <td>${raid.itemLevelRequirement}</td>
      <td>${raid.durationMinutes}</td>
      <td>${raid.id}</td>
      <td>
        <button
          data-action="edit-raid"
          data-id="${raid.id}"
          data-name="${raid.name}"
          data-difficulty="${raid.difficulty}"
          data-ilvl="${raid.itemLevelRequirement}"
          data-duration="${raid.durationMinutes}"
        >Edit</button>
        <button data-action="delete-raid" data-id="${raid.id}">Delete</button>
      </td>
    `;
    raidsTable.append(row);
  }
}

function renderAvailability(windows, playersById) {
  availabilityTable.innerHTML = "";
  for (const window of windows) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${normalizeDisplayText(playersById.get(window.playerId) ?? window.playerId)}</td>
      <td>${dayNames[window.dayOfWeek] ?? window.dayOfWeek}</td>
      <td>${window.startMinute}</td>
      <td>${window.endMinute}</td>
      <td>${window.id}</td>
      <td>
        <button
          data-action="edit-availability"
          data-id="${window.id}"
          data-player-id="${window.playerId}"
          data-day="${window.dayOfWeek}"
          data-start="${window.startMinute}"
          data-end="${window.endMinute}"
        >Edit</button>
        <button data-action="delete-availability" data-id="${window.id}">Delete</button>
      </td>
    `;
    availabilityTable.append(row);
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatMinuteOfDay(minuteOfDay) {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function reflowDayTimes(dayRows) {
  if (!dayRows.length) {
    return;
  }

  const validStarts = dayRows
    .map((r) => Number(r.startMinute))
    .filter((n) => Number.isFinite(n));
  let running = validStarts.length > 0 ? Math.min(...validStarts) : 1020;

  for (const row of dayRows) {
    row.startMinute = running;
    row.time = formatMinuteOfDay(running);
    const duration = Number(row.durationMinutes);
    running += Number.isFinite(duration) && duration > 0 ? duration : 20;
  }
}

function ensureSupportCapacity(row, supportCount) {
  if (!Array.isArray(row.supports)) {
    row.supports = [];
  }
  while (row.supports.length < supportCount) {
    row.supports.push("");
  }
}

function getSlotValue(row, slot) {
  if (slot.type === "core") {
    return row.corePlayers?.[slot.playerKey] ?? "";
  }
  return row.supports?.[slot.supportIndex] ?? "";
}

function setSlotValue(row, slot, value, supportCount) {
  if (slot.type === "core") {
    row.corePlayers[slot.playerKey] = value;
    return;
  }

  ensureSupportCapacity(row, supportCount);
  row.supports[slot.supportIndex] = value;
}

function supportValueToPlayerName(value) {
  const key = normalizeLookupKey(value);
  if (!key) {
    return "";
  }

  const byName = latestPlayers.find((p) => normalizeLookupKey(p.name) === key);
  if (byName) {
    return byName.name;
  }

  const byCharacter = latestCharacters.find((c) => normalizeLookupKey(c.name) === key);
  if (!byCharacter) {
    return "";
  }

  const owner = latestPlayers.find((p) => p.id === byCharacter.playerId);
  return owner?.name ?? "";
}

function rowAssignmentCount(row, coreCols, supportCount) {
  const selectedPlayers = new Set();
  for (const key of coreCols) {
    if ((row.corePlayers?.[key] ?? "") !== "") {
      selectedPlayers.add(key);
    }
  }

  ensureSupportCapacity(row, supportCount);
  for (let i = 0; i < supportCount; i += 1) {
    const supportValue = row.supports?.[i] ?? "";
    if (!supportValue) {
      continue;
    }

    const ownerName = supportValueToPlayerName(supportValue);
    if (ownerName) {
      selectedPlayers.add(ownerName);
    }
  }

  return selectedPlayers.size;
}

function tryPlaceSupportReplacement(row, replacementValue, supportCount) {
  ensureSupportCapacity(row, supportCount);
  for (let i = 0; i < supportCount; i += 1) {
    if ((row.supports[i] ?? "") === "") {
      row.supports[i] = replacementValue;
      return true;
    }
  }
  return false;
}

function renderScheduleGrid(grid) {
  if (!grid?.days?.length) {
    scheduleGrid.classList.add("empty");
    scheduleGrid.textContent = "No schedule rows were generated with current data.";
    return;
  }

  const coreCols = grid.columns?.corePlayers ?? [];
  const supportCount = Number(grid.columns?.supports ?? 2);

  const table = document.createElement("table");
  table.className = "schedule-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const headers = [
    "Notes",
    "Time",
    "Raid",
    ...coreCols.map((name) => normalizeDisplayText(name)),
    ...Array.from({ length: supportCount }, (_, index) => `Support ${index + 1}`),
    "Count"
  ];

  for (const header of headers) {
    const th = document.createElement("th");
    th.textContent = header;
    headRow.append(th);
  }

  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");

  for (let dayIndex = 0; dayIndex < grid.days.length; dayIndex += 1) {
    const dayBlock = grid.days[dayIndex];
    const dayRows = dayBlock.rows ?? [];
    if (dayRows.length > 0) {
      const dividerRow = document.createElement("tr");
      dividerRow.className = "day-break-row";

      const dividerCell = document.createElement("td");
      dividerCell.colSpan = headers.length;
      dividerCell.textContent = dayBlock.day ?? "";
      dividerCell.className = "day-break-cell";

      dividerRow.append(dividerCell);
      tbody.append(dividerRow);
    }

    for (let rowIndex = 0; rowIndex < dayRows.length; rowIndex += 1) {
      const row = dayRows[rowIndex];
      const tr = document.createElement("tr");
      tr.draggable = true;
      tr.dataset.dayIndex = String(dayIndex);
      tr.dataset.rowIndex = String(rowIndex);

      const currentCount = rowAssignmentCount(row, coreCols, supportCount);
      row.count = currentCount;
      tr.classList.toggle("impossible-row", currentCount > 8);

      const supportCells = Array.from({ length: supportCount }, (_, i) => row.supports?.[i] ?? "");
      const noteCell = document.createElement("td");
      noteCell.className = "note-cell";
      noteCell.dataset.noteKey = row.rowKey ?? `${dayBlock.day}-${row.time}-${row.raid}`;
      noteCell.textContent = normalizeDisplayText(row.notes ?? "");
      noteCell.title = "Click to edit note";
      tr.append(noteCell);

      const textCells = [
        row.time ?? "",
        row.raid ?? ""
      ];

      for (const value of textCells) {
        const td = document.createElement("td");
        td.innerHTML = escapeHtml(normalizeDisplayText(value));
        tr.append(td);
      }

      for (const playerName of coreCols) {
        const td = document.createElement("td");
        td.className = "slot-cell";
        td.dataset.slotType = "core";
        td.dataset.playerKey = playerName;
        td.dataset.dayIndex = String(dayIndex);
        td.dataset.rowIndex = String(rowIndex);

        const value = normalizeDisplayText(row.corePlayers?.[playerName] ?? "");
        if (value) {
          td.innerHTML = `<span class="drag-token" draggable="true">${escapeHtml(value)}</span>`;
        }
        tr.append(td);
      }

      for (let i = 0; i < supportCount; i += 1) {
        const td = document.createElement("td");
        td.className = "slot-cell support-slot";
        td.dataset.slotType = "support";
        td.dataset.supportIndex = String(i);
        td.dataset.dayIndex = String(dayIndex);
        td.dataset.rowIndex = String(rowIndex);

        const value = normalizeDisplayText(supportCells[i] ?? "");
        if (value) {
          td.innerHTML = `<span class="drag-token" draggable="true">${escapeHtml(value)}</span>`;
        }
        tr.append(td);
      }

      const countTd = document.createElement("td");
      countTd.textContent = String(currentCount);
      tr.append(countTd);

      tbody.append(tr);
    }
  }

  table.append(tbody);

  scheduleGrid.classList.remove("empty");
  scheduleGrid.innerHTML = "";
  scheduleGrid.append(table);
}

async function refresh() {
  const [players, characters, raids, availability] = await Promise.all([
    api("/players"),
    api("/characters"),
    api("/raids"),
    api("/availability-windows")
  ]);
  latestPlayers = players;
  latestCharacters = characters;
  latestRaids = raids;
  const playersById = new Map(players.map((p) => [p.id, p.name]));
  renderPlayers(players);
  renderCharacters(characters, playersById, raids);
  renderRaids(raids);
  renderAvailability(availability, playersById);
  buildPlayerSelect(players);
}

playerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.getElementById("player-name").value.trim();
  if (!name) {
    return;
  }

  try {
    await api("/players", {
      method: "POST",
      body: JSON.stringify({ name })
    });
    document.getElementById("player-name").value = "";
    await refresh();
    setStatus("Player added.");
  } catch (error) {
    setStatus(error.message, true);
  }
});

characterForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    playerId: document.getElementById("character-player").value,
    name: document.getElementById("character-name").value.trim(),
    role: document.getElementById("character-role").value,
    itemLevel: Number(document.getElementById("character-ilvl").value)
  };

  try {
    await api("/characters", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    document.getElementById("character-name").value = "";
    document.getElementById("character-ilvl").value = "";
    await refresh();
    setStatus("Character added.");
  } catch (error) {
    setStatus(error.message, true);
  }
});

raidForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    name: document.getElementById("raid-name").value.trim(),
    difficulty: document.getElementById("raid-difficulty").value,
    itemLevelRequirement: Number(document.getElementById("raid-ilvl").value),
    durationMinutes: Number(document.getElementById("raid-duration").value)
  };

  try {
    await api("/raids", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    document.getElementById("raid-name").value = "";
    document.getElementById("raid-ilvl").value = "";
    document.getElementById("raid-duration").value = "";
    await refresh();
    setStatus("Raid added.");
  } catch (error) {
    setStatus(error.message, true);
  }
});

availabilityForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    playerId: document.getElementById("availability-player").value,
    dayOfWeek: Number(document.getElementById("availability-day").value),
    startMinute: Number(document.getElementById("availability-start").value),
    endMinute: Number(document.getElementById("availability-end").value)
  };

  try {
    await api("/availability-windows", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    document.getElementById("availability-start").value = "";
    document.getElementById("availability-end").value = "";
    await refresh();
    setStatus("Availability window added.");
  } catch (error) {
    setStatus(error.message, true);
  }
});

playersTable.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) {
    return;
  }

  const action = button.dataset.action;
  const id = button.dataset.id;

  try {
    if (action === "delete-player") {
      await api(`/players/${id}`, { method: "DELETE" });
      await refresh();
      setStatus("Player deleted.");
      return;
    }

    if (action === "edit-player") {
      const currentName = button.dataset.name;
      const nextName = window.prompt("New player name", currentName);
      if (!nextName || !nextName.trim()) {
        return;
      }
      await api(`/players/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: nextName.trim() })
      });
      await refresh();
      setStatus("Player updated.");
    }
  } catch (error) {
    setStatus(error.message, true);
  }
});

charactersTable.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) {
    return;
  }

  const action = button.dataset.action;
  const id = button.dataset.id;

  try {
    if (action === "delete-character") {
      await api(`/characters/${id}`, { method: "DELETE" });
      await refresh();
      setStatus("Character deleted.");
      return;
    }

    if (action === "edit-character") {
      const nextName = window.prompt("Character name", button.dataset.name);
      if (!nextName || !nextName.trim()) {
        return;
      }

      const nextRole = window.prompt("Role: DPS, Support, DPS/Support", button.dataset.role);
      if (!nextRole || !["DPS", "Support", "DPS/Support"].includes(nextRole)) {
        setStatus("Invalid role.", true);
        return;
      }

      const nextItemLevelText = window.prompt("Item Level", button.dataset.ilvl);
      const nextItemLevel = Number(nextItemLevelText);
      if (!Number.isInteger(nextItemLevel) || nextItemLevel <= 0) {
        setStatus("Invalid item level.", true);
        return;
      }

      await api(`/characters/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: nextName.trim(),
          role: nextRole,
          itemLevel: nextItemLevel,
          playerId: button.dataset.playerId
        })
      });
      await refresh();
      setStatus("Character updated.");
    }
  } catch (error) {
    setStatus(error.message, true);
  }
});

charactersTable.addEventListener("change", async (event) => {
  const input = event.target.closest('input[data-action="toggle-raid-optout"]');
  if (!input) {
    return;
  }

  const characterId = input.dataset.characterId;
  const raidId = input.dataset.raidId;
  const isChecked = input.checked;
  const character = latestCharacters.find((c) => c.id === characterId);

  if (!character || !raidId) {
    setStatus("Unable to update raid selection.", true);
    return;
  }

  const nextOptOut = new Set(character.raidOptOutRaidIds ?? []);
  if (isChecked) {
    nextOptOut.delete(raidId);
  } else {
    nextOptOut.add(raidId);
  }

  try {
    await api(`/characters/${characterId}`, {
      method: "PATCH",
      body: JSON.stringify({
        raidOptOutRaidIds: [...nextOptOut]
      })
    });
    await refresh();
    setStatus("Character raid preferences updated.");
  } catch (error) {
    input.checked = !isChecked;
    setStatus(error.message, true);
  }
});

raidsTable.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) {
    return;
  }

  const action = button.dataset.action;
  const id = button.dataset.id;

  try {
    if (action === "delete-raid") {
      await api(`/raids/${id}`, { method: "DELETE" });
      await refresh();
      setStatus("Raid deleted.");
      return;
    }

    if (action === "edit-raid") {
      const nextName = window.prompt("Raid name", button.dataset.name);
      if (!nextName || !nextName.trim()) {
        return;
      }

      const nextDifficulty = window.prompt("Difficulty: Normal, Hard, Nightmare", button.dataset.difficulty);
      if (!nextDifficulty || !["Normal", "Hard", "Nightmare"].includes(nextDifficulty)) {
        setStatus("Invalid difficulty.", true);
        return;
      }

      const nextIlvlText = window.prompt("Item level requirement", button.dataset.ilvl);
      const nextIlvl = Number(nextIlvlText);
      if (!Number.isInteger(nextIlvl) || nextIlvl <= 0) {
        setStatus("Invalid item level requirement.", true);
        return;
      }

      const nextDurationText = window.prompt("Duration minutes", button.dataset.duration);
      const nextDuration = Number(nextDurationText);
      if (!Number.isInteger(nextDuration) || nextDuration <= 0 || nextDuration > 1440) {
        setStatus("Invalid duration.", true);
        return;
      }

      await api(`/raids/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: nextName.trim(),
          difficulty: nextDifficulty,
          itemLevelRequirement: nextIlvl,
          durationMinutes: nextDuration
        })
      });
      await refresh();
      setStatus("Raid updated.");
    }
  } catch (error) {
    setStatus(error.message, true);
  }
});

availabilityTable.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) {
    return;
  }

  const action = button.dataset.action;
  const id = button.dataset.id;

  try {
    if (action === "delete-availability") {
      await api(`/availability-windows/${id}`, { method: "DELETE" });
      await refresh();
      setStatus("Availability window deleted.");
      return;
    }

    if (action === "edit-availability") {
      const nextDayText = window.prompt("Day (0=Sunday..6=Saturday)", button.dataset.day);
      const nextDay = Number(nextDayText);
      if (!Number.isInteger(nextDay) || nextDay < 0 || nextDay > 6) {
        setStatus("Invalid day.", true);
        return;
      }

      const nextStartText = window.prompt("Start minute", button.dataset.start);
      const nextStart = Number(nextStartText);
      if (!Number.isInteger(nextStart) || nextStart < 0 || nextStart > 1439) {
        setStatus("Invalid start minute.", true);
        return;
      }

      const nextEndText = window.prompt("End minute", button.dataset.end);
      const nextEnd = Number(nextEndText);
      if (!Number.isInteger(nextEnd) || nextEnd < 1 || nextEnd > 1440 || nextEnd <= nextStart) {
        setStatus("Invalid end minute.", true);
        return;
      }

      await api(`/availability-windows/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          playerId: button.dataset.playerId,
          dayOfWeek: nextDay,
          startMinute: nextStart,
          endMinute: nextEnd
        })
      });
      await refresh();
      setStatus("Availability updated.");
    }
  } catch (error) {
    setStatus(error.message, true);
  }
});

generateScheduleButton.addEventListener("click", async () => {
  generateScheduleButton.disabled = true;
  generateScheduleButton.textContent = "Generating...";

  try {
    const grid = await api("/schedules/grid", {
      method: "POST",
      body: JSON.stringify({})
    });

    currentGridModel = JSON.parse(JSON.stringify(grid));
    renderScheduleGrid(currentGridModel);
    setStatus("Schedule grid generated.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    generateScheduleButton.disabled = false;
    generateScheduleButton.textContent = "Generate Schedule Grid";
  }
});

scheduleGrid.addEventListener("click", (event) => {
  const noteCell = event.target.closest("td.note-cell");
  if (!noteCell || !currentGridModel) {
    return;
  }

  const dayRow = noteCell.closest("tr[data-day-index][data-row-index]");
  if (!dayRow) {
    return;
  }

  const dayIndex = Number(dayRow.dataset.dayIndex);
  const rowIndex = Number(dayRow.dataset.rowIndex);
  const row = currentGridModel.days?.[dayIndex]?.rows?.[rowIndex];
  if (!row) {
    return;
  }

  const next = window.prompt("Row note", row.notes ?? "");
  if (next === null) {
    return;
  }

  row.notes = next;
  renderScheduleGrid(currentGridModel);
  setStatus("Note updated for this generated view.");
});

function parseSlotFromCell(cell) {
  if (!cell) {
    return null;
  }

  const slotType = cell.dataset.slotType;
  if (slotType === "core") {
    return {
      type: "core",
      playerKey: cell.dataset.playerKey
    };
  }

  if (slotType === "support") {
    return {
      type: "support",
      supportIndex: Number(cell.dataset.supportIndex)
    };
  }

  return null;
}

function moveTokenBetweenSlots(sourceRef, targetRef) {
  if (!currentGridModel) {
    return;
  }

  const supportCount = Number(currentGridModel.columns?.supports ?? 2);
  const sourceRow = currentGridModel.days?.[sourceRef.dayIndex]?.rows?.[sourceRef.rowIndex];
  const targetRow = currentGridModel.days?.[targetRef.dayIndex]?.rows?.[targetRef.rowIndex];
  if (!sourceRow || !targetRow) {
    return;
  }

  if (sourceRow.raid !== targetRow.raid) {
    setStatus("Players can only be moved between rows of the same raid.", true);
    return;
  }

  const sourceValue = getSlotValue(sourceRow, sourceRef.slot);
  if (!sourceValue) {
    return;
  }

  const targetValue = getSlotValue(targetRow, targetRef.slot);
  setSlotValue(targetRow, targetRef.slot, sourceValue, supportCount);
  setSlotValue(sourceRow, sourceRef.slot, "", supportCount);

  if (targetValue) {
    if (
      targetRef.slot.type === "support"
      && sourceRef.slot.type !== "support"
      && !tryPlaceSupportReplacement(sourceRow, targetValue, supportCount)
    ) {
      setSlotValue(sourceRow, sourceRef.slot, targetValue, supportCount);
    } else {
      setSlotValue(sourceRow, sourceRef.slot, targetValue, supportCount);
    }
  }
}

scheduleGrid.addEventListener("dragstart", (event) => {
  const token = event.target.closest(".drag-token");
  if (token) {
    const sourceCell = token.closest("td.slot-cell");
    const slot = parseSlotFromCell(sourceCell);
    if (!slot || !sourceCell || !currentGridModel) {
      return;
    }

    activeDrag = {
      type: "token",
      source: {
        dayIndex: Number(sourceCell.dataset.dayIndex),
        rowIndex: Number(sourceCell.dataset.rowIndex),
        slot
      }
    };
    token.classList.add("is-dragging-token");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
    event.stopPropagation();
    return;
  }

  const row = event.target.closest("tr[data-day-index][data-row-index]");
  if (row && currentGridModel) {
    activeDrag = {
      type: "row",
      dayIndex: Number(row.dataset.dayIndex),
      rowIndex: Number(row.dataset.rowIndex)
    };
    row.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
  }
});

scheduleGrid.addEventListener("dragover", (event) => {
  if (!activeDrag) {
    return;
  }

  if (activeDrag.type === "token") {
    const slotCell = event.target.closest("td.slot-cell");
    if (!slotCell) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    return;
  }

  if (activeDrag.type === "row") {
    const row = event.target.closest("tr[data-day-index][data-row-index]");
    if (!row) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  }
});

scheduleGrid.addEventListener("drop", (event) => {
  if (!activeDrag || !currentGridModel) {
    return;
  }

  if (activeDrag.type === "token") {
    const targetCell = event.target.closest("td.slot-cell");
    const targetSlot = parseSlotFromCell(targetCell);
    if (!targetCell || !targetSlot) {
      return;
    }

    event.preventDefault();
    const targetRef = {
      dayIndex: Number(targetCell.dataset.dayIndex),
      rowIndex: Number(targetCell.dataset.rowIndex),
      slot: targetSlot
    };

    if (
      activeDrag.source.dayIndex === targetRef.dayIndex
      && activeDrag.source.rowIndex === targetRef.rowIndex
      && activeDrag.source.slot.type === targetRef.slot.type
      && (activeDrag.source.slot.type === "core"
        ? activeDrag.source.slot.playerKey === targetRef.slot.playerKey
        : activeDrag.source.slot.supportIndex === targetRef.slot.supportIndex)
    ) {
      return;
    }

    moveTokenBetweenSlots(activeDrag.source, targetRef);
    renderScheduleGrid(currentGridModel);
    setStatus("Player arrangement updated. Red rows are impossible (>8).", false);
    return;
  }

  const targetRow = event.target.closest("tr[data-day-index][data-row-index]");
  if (!targetRow) {
    return;
  }

  event.preventDefault();
  const targetDayIndex = Number(targetRow.dataset.dayIndex);
  const targetRowIndex = Number(targetRow.dataset.rowIndex);

  const sourceRows = currentGridModel.days?.[activeDrag.dayIndex]?.rows;
  const targetRows = currentGridModel.days?.[targetDayIndex]?.rows;
  if (!sourceRows || !targetRows || activeDrag.rowIndex < 0 || activeDrag.rowIndex >= sourceRows.length) {
    return;
  }

  const [moved] = sourceRows.splice(activeDrag.rowIndex, 1);
  if (!moved) {
    return;
  }

  let insertIndex = targetRowIndex;
  if (activeDrag.dayIndex === targetDayIndex && activeDrag.rowIndex < targetRowIndex) {
    insertIndex -= 1;
  }
  insertIndex = Math.max(0, Math.min(insertIndex, targetRows.length));
  targetRows.splice(insertIndex, 0, moved);

  reflowDayTimes(targetRows);
  if (sourceRows !== targetRows) {
    reflowDayTimes(sourceRows);
  }
  renderScheduleGrid(currentGridModel);
  setStatus("Row reordered and times updated.");
});

scheduleGrid.addEventListener("dragend", () => {
  activeDrag = null;
  const dragging = scheduleGrid.querySelector("tr.is-dragging");
  if (dragging) {
    dragging.classList.remove("is-dragging");
  }

  const draggingToken = scheduleGrid.querySelector(".is-dragging-token");
  if (draggingToken) {
    draggingToken.classList.remove("is-dragging-token");
  }
});

refresh().catch((error) => setStatus(error.message, true));
