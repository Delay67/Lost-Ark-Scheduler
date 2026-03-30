const statusEl = document.getElementById("status");
const playersTable = document.getElementById("players-table");
const charactersTable = document.getElementById("characters-table");
const characterPlayerSelect = document.getElementById("character-player");

const playerForm = document.getElementById("player-form");
const characterForm = document.getElementById("character-form");

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
  for (const player of players) {
    const option = document.createElement("option");
    option.value = player.id;
    option.textContent = player.name;
    characterPlayerSelect.append(option);
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

async function refresh() {
  const [players, characters] = await Promise.all([api("/players"), api("/characters")]);
  const playersById = new Map(players.map((p) => [p.id, p.name]));
  renderPlayers(players);
  renderCharacters(characters, playersById);
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

refresh().catch((error) => setStatus(error.message, true));
