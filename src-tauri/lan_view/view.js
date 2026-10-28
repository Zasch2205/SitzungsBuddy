const fields = {
  meetingDate: document.getElementById("meetingDate"),
  meetingLocation: document.getElementById("meetingLocation"),
  meetingTitle: document.getElementById("meetingTitle"),
  meetingSubtitle: document.getElementById("meetingSubtitle"),
  onAirStatus: document.getElementById("onAirStatus"),
  currentClock: document.getElementById("currentClock"),
  sessionElapsed: document.getElementById("sessionElapsed"),
  prognosis: document.getElementById("prognosis"),
  currentTop: document.getElementById("currentTop"),
  topElapsed: document.getElementById("topElapsed"),
  countdown: document.getElementById("countdown"),
  sessionStart: document.getElementById("sessionStart"),
  sessionEnd: document.getElementById("sessionEnd"),
  nextBreak: document.getElementById("nextBreak"),
  agendaList: document.getElementById("agendaList"),
  agendaScroll: document.getElementById("agendaScroll"),
  connectionStatus: document.getElementById("connectionStatus"),
};

let loading = false;
let lastLiveRowIndex = -1;

function setText(field, value) {
  fields[field].textContent = typeof value === "string" ? value : "";
}

function setTone(field, tone) {
  fields[field].classList.toggle("green", tone === "green");
  fields[field].classList.toggle("red", tone === "red");
}

function createText(className, value) {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = String(value ?? "");
  return element;
}

function renderAgenda(state) {
  const fragment = document.createDocumentFragment();
  const rows = Array.isArray(state.rows) ? state.rows : [];
  let liveRowIndex = -1;

  rows.forEach((item, index) => {
    const row = document.createElement("li");
    row.className = "agendaRow";
    row.classList.toggle("break", item.kind === "break");
    row.classList.toggle("heading", item.kind === "heading");
    row.classList.toggle("hold", item.state === "hold");
    row.classList.toggle("next", item.isNext === true);
    row.classList.toggle("live", item.isCurrent === true);
    row.classList.toggle("finished", item.state === "done" || item.state === "skipped");

    if (item.isCurrent === true) {
      liveRowIndex = index;
    }

    if (item.kind === "placeholder") {
      row.append(createText("rowTitle", item.title));
    } else if (item.kind === "heading") {
      row.append(createText("rowBadge", "Überschrift"));
      if (item.top) row.append(createText("rowTop", item.top));
      row.append(createText("rowTitle", item.title));
    } else {
      const badge = item.kind === "break" ? "Pause" : item.stateLabel;
      row.append(createText("rowBadge", badge));
      row.append(createText("rowMeta", `#${item.order}`));
      row.append(createText("rowTime", item.scheduledStart));
      if (item.kind !== "break" && item.top) row.append(createText("rowTop", `TOP ${item.top}`));
      row.append(createText("rowTitle", item.title));
      row.append(createText("rowDuration", item.duration));
    }

    fragment.append(row);
  });

  if (state.hasRealAgenda) {
    const endRow = document.createElement("li");
    endRow.className = "agendaRow";
    endRow.append(createText("rowBadge", "Sitzungsende"));
    endRow.append(createText("rowDuration", state.sessionEnd));
    fragment.append(endRow);
  }

  fields.agendaList.replaceChildren(fragment);

  if (liveRowIndex >= 0 && liveRowIndex !== lastLiveRowIndex) {
    const anchor = fields.agendaList.children[Math.max(0, liveRowIndex - 1)];
    fields.agendaScroll.scrollTop = anchor.offsetTop - fields.agendaList.offsetTop;
  }
  lastLiveRowIndex = liveRowIndex;
}

function render(state) {
  setText("meetingDate", state.meetingDate);
  setText("meetingLocation", state.meetingLocation);
  setText("meetingTitle", state.meetingTitle);
  setText("meetingSubtitle", state.meetingSubtitle);
  setText("currentClock", state.currentClock);
  setText("sessionElapsed", state.sessionElapsed);
  setText("prognosis", state.prognosis);
  setText("currentTop", state.currentTop);
  setText("topElapsed", state.topElapsed);
  setText("countdown", state.countdown);
  setText("sessionStart", state.sessionStart);
  setText("sessionEnd", state.sessionEnd);
  setText("nextBreak", state.nextBreak);
  setTone("prognosis", state.prognosisTone);
  setTone("countdown", state.countdownTone);
  fields.sessionElapsed.classList.toggle("paused", state.isPaused === true);
  fields.topElapsed.classList.toggle("paused", state.isPaused === true);
  fields.onAirStatus.classList.toggle("active", state.onAir === true);
  fields.onAirStatus.textContent = state.onAir === true ? "On Air" : "Off Air";
  renderAgenda(state);
}

async function refresh() {
  if (loading) return;
  loading = true;

  try {
    const response = await fetch(new URL("state", window.location.href), { cache: "no-store" });
    if (!response.ok) throw new Error("Sitzungsdaten nicht erreichbar");
    const state = await response.json();
    if (!Array.isArray(state.rows)) {
      fields.connectionStatus.textContent = "Sitzungsdaten werden geladen …";
      fields.connectionStatus.classList.add("waiting");
      fields.connectionStatus.hidden = false;
      return;
    }
    render(state);
    fields.connectionStatus.classList.remove("waiting");
    fields.connectionStatus.hidden = true;
  } catch {
    fields.connectionStatus.classList.remove("waiting");
    fields.connectionStatus.textContent = "Verbindung unterbrochen oder LAN-Freigabe beendet. Die letzte Anzeige ist möglicherweise veraltet.";
    fields.connectionStatus.hidden = false;
  } finally {
    loading = false;
  }
}

void refresh();
window.setInterval(refresh, 1000);
