import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";

type AgendaState = "planned" | "live" | "hold" | "done" | "skipped";

type AgendaItem = {
  id: string;
  day: string;
  order: number;
  top: string;
  title: string;
  plannedDurationSec: number;
  state: AgendaState;
};

const initialAgenda: AgendaItem[] = [
  {
    id: "d1-1",
    day: "Tag 1",
    order: 1,
    top: "1",
    title: "Begrüßung und Zielsetzung",
    plannedDurationSec: 15 * 60,
    state: "planned",
  },
  {
    id: "d1-2",
    day: "Tag 1",
    order: 2,
    top: "2",
    title: "Statusberichte der Fachbereiche",
    plannedDurationSec: 45 * 60,
    state: "planned",
  },
  {
    id: "d1-3",
    day: "Tag 1",
    order: 3,
    top: "3",
    title: "Entscheidung Budget 2027",
    plannedDurationSec: 30 * 60,
    state: "planned",
  },
  {
    id: "d2-1",
    day: "Tag 2",
    order: 4,
    top: "4",
    title: "Roadmap-Planung",
    plannedDurationSec: 60 * 60,
    state: "planned",
  },
];

const movableStates: AgendaState[] = ["planned", "hold"];

function normalizeOrder(items: AgendaItem[]): AgendaItem[] {
  return items.map((item, index) => ({ ...item, order: index + 1 }));
}

function formatClock(seconds: number): string {
  const absSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(absSeconds / 3600);
  const minutes = Math.floor((absSeconds % 3600) / 60);
  const secs = absSeconds % 60;
  return [hours, minutes, secs].map((part) => part.toString().padStart(2, "0")).join(":");
}

function formatCompact(seconds: number): string {
  const absSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(absSeconds / 3600);
  const minutes = Math.floor((absSeconds % 3600) / 60);
  const secs = absSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, secs].map((part) => part.toString().padStart(2, "0")).join(":");
  }

  return [minutes, secs].map((part) => part.toString().padStart(2, "0")).join(":");
}

function stateLabel(state: AgendaState): string {
  switch (state) {
    case "planned":
      return "Geplant";
    case "live":
      return "Live";
    case "hold":
      return "Halt";
    case "done":
      return "Erledigt";
    case "skipped":
      return "Übersprungen";
    default:
      return state;
  }
}

function App() {
  const [agenda, setAgenda] = useState<AgendaItem[]>(initialAgenda);
  const [onAir, setOnAir] = useState(false);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [currentItemId, setCurrentItemId] = useState<string | null>(null);
  const [currentItemStartedAt, setCurrentItemStartedAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(Date.now());

  const currentIndex = useMemo(
    () => agenda.findIndex((item) => item.id === currentItemId),
    [agenda, currentItemId],
  );

  const currentItem = currentIndex >= 0 ? agenda[currentIndex] : null;

  const totalElapsedSec = useMemo(() => {
    if (sessionStartedAt === null) {
      return 0;
    }

    return Math.max(0, Math.floor((nowMs - sessionStartedAt) / 1000));
  }, [sessionStartedAt, nowMs]);

  const currentElapsedSec = useMemo(() => {
    if (currentItemStartedAt === null) {
      return 0;
    }

    return Math.max(0, Math.floor((nowMs - currentItemStartedAt) / 1000));
  }, [currentItemStartedAt, nowMs]);

  const remainingSec = currentItem ? currentItem.plannedDurationSec - currentElapsedSec : 0;

  const plannedElapsedSec = useMemo(() => {
    return agenda.reduce((sum, item) => {
      if (item.state === "done") {
        return sum + item.plannedDurationSec;
      }

      if (item.state === "live" && item.id === currentItemId) {
        return sum + Math.min(currentElapsedSec, item.plannedDurationSec);
      }

      return sum;
    }, 0);
  }, [agenda, currentElapsedSec, currentItemId]);

  const prognosisSec = totalElapsedSec - plannedElapsedSec;

  const nextPlannedIndex = useMemo(
    () => agenda.findIndex((item) => item.state === "planned"),
    [agenda],
  );

  const advanceToNextItem = useCallback(() => {
    if (!onAir) {
      return;
    }

    const timestamp = Date.now();
    const currentIndexInAgenda = currentItemId
      ? agenda.findIndex((item) => item.id === currentItemId)
      : -1;
    const nextIndex = agenda.findIndex(
      (item, index) => index > currentIndexInAgenda && item.state === "planned",
    );

    const nextItemId = nextIndex >= 0 ? agenda[nextIndex].id : null;

    const updated = agenda.map((item) => {
      if (item.id === currentItemId && item.state === "live") {
        return { ...item, state: "done" as const };
      }

      if (item.id === nextItemId) {
        return { ...item, state: "live" as const };
      }

      return item;
    });

    setAgenda(updated);
    setCurrentItemId(nextItemId);
    setCurrentItemStartedAt(nextItemId ? timestamp : null);
    setNowMs(timestamp);
  }, [agenda, currentItemId, onAir]);

  const startOnAir = useCallback(() => {
    if (onAir) {
      return;
    }

    const timestamp = Date.now();
    setOnAir(true);
    setNowMs(timestamp);

    if (sessionStartedAt === null) {
      setSessionStartedAt(timestamp);
    }

    if (currentItemId !== null) {
      return;
    }

    const firstPlanned = agenda.find((item) => item.state === "planned");
    if (!firstPlanned) {
      return;
    }

    setAgenda((previous) =>
      previous.map((item) =>
        item.id === firstPlanned.id ? { ...item, state: "live" as const } : item,
      ),
    );
    setCurrentItemId(firstPlanned.id);
    setCurrentItemStartedAt(timestamp);
  }, [agenda, currentItemId, onAir, sessionStartedAt]);

  const moveFutureItem = useCallback(
    (index: number, direction: -1 | 1) => {
      setAgenda((previous) => {
        const targetIndex = index + direction;
        if (targetIndex < 0 || targetIndex >= previous.length) {
          return previous;
        }

        const currentIndexInPrevious = currentItemId
          ? previous.findIndex((item) => item.id === currentItemId)
          : -1;

        if (index <= currentIndexInPrevious || targetIndex <= currentIndexInPrevious) {
          return previous;
        }

        if (!movableStates.includes(previous[index].state)) {
          return previous;
        }

        if (!movableStates.includes(previous[targetIndex].state)) {
          return previous;
        }

        const swapped = [...previous];
        const source = swapped[index];
        swapped[index] = swapped[targetIndex];
        swapped[targetIndex] = source;
        return normalizeOrder(swapped);
      });
    },
    [currentItemId],
  );

  const toggleHold = useCallback(
    (index: number) => {
      setAgenda((previous) => {
        const currentIndexInPrevious = currentItemId
          ? previous.findIndex((item) => item.id === currentItemId)
          : -1;

        if (index <= currentIndexInPrevious) {
          return previous;
        }

        const item = previous[index];
        if (item.state !== "planned" && item.state !== "hold") {
          return previous;
        }

        const nextState: AgendaState = item.state === "planned" ? "hold" : "planned";
        const updated = [...previous];
        updated[index] = { ...item, state: nextState };
        return updated;
      });
    },
    [currentItemId],
  );

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 250);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName)) {
        return;
      }

      event.preventDefault();
      advanceToNextItem();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [advanceToNextItem]);

  const currentClockLabel = useMemo(() => {
    return new Date(nowMs).toLocaleTimeString("de-DE", { hour12: false });
  }, [nowMs]);

  const currentDateLabel = useMemo(() => {
    return new Date(nowMs).toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
  }, [nowMs]);

  const currentTopLabel = currentItem
    ? `${currentItem.top} ${currentItem.title}`
    : "Kein aktiver TOP";

  const countdownLabel = useMemo(() => {
    if (!currentItem) {
      return "--:--";
    }

    if (remainingSec > 0) {
      return `+ ${formatCompact(remainingSec)}`;
    }

    if (remainingSec < 0) {
      return `- ${formatCompact(Math.abs(remainingSec))}`;
    }

    return "0";
  }, [currentItem, remainingSec]);

  const countdownClass = useMemo(() => {
    if (!currentItem) {
      return "deltaNeutral";
    }

    if (remainingSec > 0) {
      return "deltaGreen";
    }

    if (remainingSec < 0) {
      return "deltaRed";
    }

    return "deltaNeutral";
  }, [currentItem, remainingSec]);

  const prognosisLabel = useMemo(() => {
    if (sessionStartedAt === null || prognosisSec === 0) {
      return "0";
    }

    if (prognosisSec > 0) {
      return `+ ${formatCompact(prognosisSec)}`;
    }

    return `- ${formatCompact(Math.abs(prognosisSec))}`;
  }, [prognosisSec, sessionStartedAt]);

  const prognosisClass = useMemo(() => {
    if (sessionStartedAt === null || prognosisSec === 0) {
      return "deltaNeutral";
    }

    if (prognosisSec > 0) {
      return "deltaRed";
    }

    return "deltaGreen";
  }, [prognosisSec, sessionStartedAt]);

  return (
    <main className="appShell">
      <header className="freezeHeader">
        <div className="headerTopRow">
          <button
            type="button"
            className={onAir ? "onAirButton active" : "onAirButton"}
            onClick={startOnAir}
          >
            {onAir ? "On\nAir" : "On\nAir"}
          </button>

          <div className="titleArea">
            <h1>135. PTKO</h1>
          </div>

          <div className="dateArea">
            <p>{currentDateLabel}</p>
            <strong>Hamburg</strong>
          </div>
        </div>

        <div className="headerDivider" />

        <div className="statusLayout">
          <section className="statusColumn">
            <p className="fieldLabel">Aktuelle Uhrzeit</p>
            <div className="valueBox">{currentClockLabel}</div>

            <p className="fieldLabel">Sitzungszeit</p>
            <div className="valueBox">{formatClock(totalElapsedSec)}</div>

            <p className={`deltaValue ${prognosisClass}`}>{prognosisLabel}</p>
          </section>

          <section className="statusColumn rightColumn">
            <p className="fieldLabel">Aktueller TOP</p>
            <div className="topBox">{currentTopLabel}</div>

            <p className="fieldLabel">Zeit des TOP</p>
            <div className="valueBox">{currentItem ? formatClock(currentElapsedSec) : "--:--:--"}</div>

            <p className={`deltaValue ${countdownClass}`}>{countdownLabel}</p>
          </section>

          <aside className="actionColumn">
            <button
              type="button"
              className="actionButton"
              onClick={advanceToNextItem}
              disabled={!onAir || nextPlannedIndex < 0}
            >
              Weiter
            </button>
            <p className="spaceHint">Leertaste = Nächster TOP</p>
          </aside>
        </div>
      </header>

      <section className="agendaScrollArea">
        <article className="agendaCard">
          <h2>Agenda</h2>
          <p className="hint">Zukünftige Punkte lassen sich umsortieren oder auf Halt setzen.</p>
          <ul className="agendaList">
            {agenda.map((item, index) => {
              const isCurrent = item.id === currentItemId;
              const isFuture = currentIndex < 0 || index > currentIndex;
              const canMoveUp = isFuture && index > 0;
              const canMoveDown = isFuture && index < agenda.length - 1;
              const canToggleHold = isFuture && (item.state === "planned" || item.state === "hold");

              return (
                <li key={item.id} className={isCurrent ? "agendaItem current" : "agendaItem"}>
                  <div className="agendaMeta">
                    <span className={`badge state-${item.state}`}>{stateLabel(item.state)}</span>
                    <span className="order">#{item.order}</span>
                    <span className="day">{item.day}</span>
                    <span className="top">TOP {item.top}</span>
                    <span className="title">{item.title}</span>
                  </div>
                  <div className="agendaActions">
                    <span className="duration">{formatClock(item.plannedDurationSec)}</span>
                    <button
                      type="button"
                      className="mini"
                      onClick={() => moveFutureItem(index, -1)}
                      disabled={!canMoveUp}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="mini"
                      onClick={() => moveFutureItem(index, 1)}
                      disabled={!canMoveDown}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="mini wide"
                      onClick={() => toggleHold(index)}
                      disabled={!canToggleHold}
                    >
                      {item.state === "hold" ? "Fortsetzen" : "Halt"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </article>
      </section>
    </main>
  );
}

export default App;
