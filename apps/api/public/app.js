const statusEl = document.getElementById("status");
const playersTable = document.getElementById("players-table");
const charactersTable = document.getElementById("characters-table");
const raidsTable = document.getElementById("raids-table");
const availabilityTable = document.getElementById("availability-table");
const characterPlayerSelect = document.getElementById("character-player");
const availabilityPlayerSelect = document.getElementById("availability-player");

const playerForm = document.getElementById("player-form");
const characterForm = document.getElementById("character-form");
const raidForm = document.getElementById("raid-form");
const availabilityForm = document.getElementById("availability-form");

const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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
    option.textContent = player.name;
    characterPlayerSelect.append(option);

    const optionAvailability = document.createElement("option");
    optionAvailability.value = player.id;
    optionAvailability.textContent = player.name;
    availabilityPlayerSelect.append(optionAvailability);
  }
}

function renderPlayers(players) {
  playersTable.innerHTML = "";
  for (const player of players) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${player.name}</td>
      <td>${player.id}</td>
      <td>
        <button data-action="edit-player" data-id="${player.id}" data-name="${player.name}">Edit</button>
        <button data-action="delete-player" data-id="${player.id}">Delete</button>
      </td>
    `;
    playersTable.append(row);
  }
}

function renderCharacters(characters, playersById) {
  charactersTable.innerHTML = "";
  for (const character of characters) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${character.name}</td>
      <td>${playersById.get(character.playerId) ?? character.playerId}</td>
      <td>${character.role}</td>
      <td>${character.itemLevel}</td>
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
      <td>${playersById.get(window.playerId) ?? window.playerId}</td>
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

async function refresh() {
  const [players, characters, raids, availability] = await Promise.all([
    api("/players"),
    api("/characters"),
    api("/raids"),
    api("/availability-windows")
  ]);
  const playersById = new Map(players.map((p) => [p.id, p.name]));
  renderPlayers(players);
  renderCharacters(characters, playersById);
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

refresh().catch((error) => setStatus(error.message, true));
