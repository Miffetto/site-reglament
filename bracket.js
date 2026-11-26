const api = "https://tpbwadnchupvffipladq.supabase.co/functions/v1/tournament-bracket";
const board = document.querySelector(".bracket-board");
const notice = document.querySelector("#bracket-notice");
const login = document.querySelector("#bracket-login");
const codeInput = document.querySelector("#bracket-code");
const loginButton = login.querySelector("button");
const logoutButton = document.querySelector("#bracket-logout");
const loginStatus = document.querySelector("#bracket-login-status");
const teams = new Map();
const matches = [...board.querySelectorAll(".match-card")].map((card) => {
  const id = Number(card.id.slice("match-".length));
  const slots = [...card.querySelectorAll(".match-teams > li")];
  const openingTeams = id <= 8 ? slots.map((slot, index) => {
    const teamId = 2 * id - 1 + index;
    teams.set(teamId, {
      name: slot.querySelector(".team-name").textContent,
      points: slot.querySelector(".team-points").textContent,
    });
    return teamId;
  }) : null;
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "match-reset";
  reset.dataset.matchId = id;
  reset.textContent = "Сбросить";
  reset.setAttribute("aria-label", `Сбросить результат матча ${id}`);
  return {
    id,
    heading: card.querySelector("h3"),
    reset,
    slots,
    openingTeams,
    placeholders: openingTeams ? [] : slots.map((slot) => slot.firstElementChild.cloneNode(true)),
  };
});

let state = null;
let token = null;
let saving = false;
let refreshing = false;
let syncFailed = false;

function showNotice(message = "") {
  notice.textContent = message;
  notice.hidden = !message;
}

async function request(payload, session, timeout = 9000) {
  const response = await fetch(api, {
    method: payload ? "POST" : "GET",
    // A plain-text JSON body avoids an extra CORS request before each edit.
    headers: payload ? { "Content-Type": "text/plain;charset=UTF-8" } : undefined,
    body: payload ? JSON.stringify({ ...payload, ...(session && { session }) }) : undefined,
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(timeout),
  });
  return { status: response.status, body: await response.json() };
}

function acceptState(value) {
  if (!Number.isInteger(value?.revision) || value.revision < 0 || !value.winners ||
    typeof value.winners !== "object" || Array.isArray(value.winners) ||
    Object.entries(value.winners).some(([match, team]) => !matches.some(({ id }) => String(id) === match) || !teams.has(team))) {
    throw new Error("Invalid bracket state");
  }
  if (!state || value.revision > state.revision) {
    state = { revision: value.revision, winners: value.winners };
    render();
  }
}

async function sendResult(payload, session) {
  try {
    const result = await request(payload, session);
    return result.status < 500 ? result : null;
  } catch {
    return null;
  }
}

async function confirmResult({ matchId, teamId, revision }) {
  try {
    const result = await request(undefined, undefined, 3500);
    if (result.status === 200) acceptState(result.body);
  } catch {
    // The original revision still prevents a retry from overwriting newer results.
  }
  if ((state.winners[matchId] ?? null) === teamId) return { status: 200, body: state };
  if (state.revision !== revision) return { status: 409, body: state };
  return null;
}

async function saveResult(payload, session) {
  const result = await sendResult(payload, session);
  if (result) return result;

  showNotice("Связь прервалась. Проверяем, сохранился ли результат…");
  return await confirmResult(payload) ?? await sendResult(payload, session) ?? await confirmResult(payload);
}

function render() {
  const active = document.activeElement;
  const winners = state?.winners ?? {};
  for (const match of matches) {
    const { id, heading, reset, slots, openingTeams, placeholders } = match;
    if (token && winners[id]) {
      if (!reset.isConnected) heading.append(reset);
      reset.setAttribute("aria-disabled", String(saving));
    } else {
      reset.remove();
    }
    const participants = openingTeams ?? [winners[2 * id - 17], winners[2 * id - 16]];
    const editable = Boolean(token && state && participants.every((team) => teams.has(team)));
    slots.forEach((slot, index) => {
      const teamId = participants[index];
      const team = teams.get(teamId);
      const winner = Boolean(team && winners[id] === teamId);
      const view = `${teamId ?? 0}/${winner}/${editable}/${saving && editable}`;
      if (slot.dataset.view === view) return;
      slot.dataset.view = view;
      slot.classList.toggle("is-winner", winner);
      slot.classList.toggle("has-team-button", editable);
      if (!team) {
        slot.replaceChildren(placeholders[index].cloneNode(true));
        return;
      }

      const name = document.createElement("span");
      name.className = "team-name";
      name.textContent = team.name;
      const points = document.createElement("span");
      points.className = "team-points";
      points.textContent = team.points;
      if (!editable) {
        slot.replaceChildren(name, points);
        return;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "team-select";
      button.dataset.matchId = id;
      button.dataset.teamId = teamId;
      button.setAttribute("aria-label", `Матч ${id}. Выбрать победителем: ${team.name}`);
      button.setAttribute("aria-pressed", String(winner));
      button.setAttribute("aria-disabled", String(saving));
      button.append(name, points);
      slot.replaceChildren(button);
    });
  }
  if (active?.matches(".team-select, .match-reset") && !active.isConnected) {
    const { matchId, teamId } = active.dataset;
    const card = document.getElementById(`match-${matchId}`);
    (card.querySelector(`.team-select[data-team-id="${teamId}"]`) ?? card).focus({ preventScroll: true });
  }
}

async function refreshResults() {
  if (refreshing) return;
  refreshing = true;
  try {
    const { status, body } = await request();
    if (status !== 200) throw new Error("Bracket unavailable");
    acceptState(body);
    if (syncFailed && !saving) showNotice();
    syncFailed = false;
  } catch {
    syncFailed = true;
    if (!saving) showNotice("Не удалось обновить результаты. Повторяем подключение.");
  } finally {
    refreshing = false;
  }
}

function setOrganizer(session) {
  token = session;
  login.hidden = Boolean(token);
  logoutButton.hidden = !token;
  loginStatus.textContent = token ? "Нажми на победившую команду в карточке матча." : "";
  render();
}

login.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (loginButton.disabled || !login.reportValidity()) return;
  const code = codeInput.value;
  codeInput.value = "";
  loginButton.disabled = true;
  loginStatus.textContent = "Проверяем код…";
  try {
    const { status, body } = await request({ action: "login", code });
    if (status === 200 && typeof body.token === "string" && /^[0-9a-f]{64}$/.test(body.token)) {
      setOrganizer(body.token);
      logoutButton.focus();
      await refreshResults();
    } else if (status === 401) {
      loginStatus.textContent = "Неверный код.";
      codeInput.focus();
    } else if (status === 429) {
      const minutes = Math.max(1, Math.ceil(Number(body.retryAfter) / 60) || 1);
      loginStatus.textContent = `Слишком много попыток. Попробуй через ${minutes} мин.`;
    } else {
      loginStatus.textContent = "Не удалось проверить код. Попробуй ещё раз.";
    }
  } catch {
    loginStatus.textContent = "Нет связи с сервером. Попробуй ещё раз.";
  } finally {
    loginButton.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  if (saving || !token) return;
  const session = token;
  setOrganizer(null);
  codeInput.focus();
  try {
    await request({ action: "logout" }, session);
  } catch {
    loginStatus.textContent = "Режим организатора закрыт в этой вкладке.";
  }
});

board.addEventListener("click", async (event) => {
  const button = event.target.closest(".team-select, .match-reset");
  if (!button || !token || !state || saving) return;
  const matchId = Number(button.dataset.matchId);
  const isReset = button.classList.contains("match-reset");
  const teamId = isReset ? null : Number(button.dataset.teamId);
  if ((state.winners[matchId] ?? null) === teamId) return;

  let hasDependentResult = false;
  for (let next = matchId; next < 15 && !hasDependentResult;) {
    next = 8 + Math.ceil(next / 2);
    hasDependentResult = Boolean(state.winners[next]);
  }
  if (isReset || hasDependentResult) {
    const prompt = isReset ? `Сбросить результат матча ${matchId}?` : "Исправить победителя?";
    const detail = hasDependentResult ? " Результаты зависимых матчей тоже будут сброшены." : "";
    if (!window.confirm(prompt + detail)) return;
  }

  saving = true;
  logoutButton.disabled = true;
  showNotice(isReset ? "Сбрасываем результат…" : "Сохраняем результат…");
  render();
  try {
    const result = await saveResult({ action: isReset ? "reset" : "winner", matchId, teamId, revision: state.revision }, token);
    if (!result) {
      showNotice("Не удалось подтвердить изменение. Проверь результат в сетке и при необходимости повтори действие.");
      return;
    }
    const { status, body } = result;
    if (status === 200 || status === 409) {
      acceptState(body);
      const success = `Результат матча ${matchId} ${isReset ? "сброшен" : "сохранён"}.`;
      showNotice((state.winners[matchId] ?? null) === teamId
        ? success
        : "Сетка уже изменилась. Проверь результат матча и повтори действие.");
    } else if (status === 401) {
      setOrganizer(null);
      showNotice("Сессия истекла. Введи код ещё раз внизу страницы.");
    } else if (status === 422) {
      showNotice("Дождись результатов предыдущих матчей и проверь участников.");
    } else {
      showNotice("Не удалось изменить результат. Попробуй ещё раз.");
    }
  } catch {
    showNotice("Не удалось подтвердить изменение. Проверь результат в сетке и при необходимости повтори действие.");
  } finally {
    saving = false;
    logoutButton.disabled = false;
    render();
    refreshResults();
  }
});

loginButton.disabled = false;
refreshResults();
window.setInterval(() => {
  if (!document.hidden && !saving) refreshResults();
}, 10000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !saving) refreshResults();
});
