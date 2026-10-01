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
    top: "TOP 1",
    title: "Begrüßung und Zielsetzung",
    plannedDurationSec: 15 * 60,
    state: "planned",
  },
  {
    id: "d1-2",
    day: "Tag 1",
    order: 2,
    top: "TOP 2",
    title: "Statusberichte der Fachbereiche",
    plannedDurationSec: 45 * 60,
    state: "planned",
  },
  {
    id: "d1-3",
    day: "Tag 1",
    order: 3,
    top: "TOP 3",
    title: "Entscheidung Budget 2027",
    plannedDurationSec: 30 * 60,
    state: "planned",
  },
  {
    id: "d2-1",
    day: "Tag 2",
    order: 4,
    top: "TOP 4",
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

function formatSigned(seconds: number): string {
  if (seconds >= 0) {
    return formatClock(seconds);
  }

  return `+${formatClock(Math.abs(seconds))}`;
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
  }, [agenda, currentItemId, sessionStartedAt]);

  const stopOnAir = useCallback(() => {
    setOnAir(false);
  }, []);

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
    if (!onAir && sessionStartedAt === null) {
      return;
    }

    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 250);

    return () => window.clearInterval(interval);
  }, [onAir, sessionStartedAt]);

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

  return (
    <main className="layout">
      <header className="topBar">
        <div>
          <p className="eyebrow">Sitzungsbuddy</p>
          <h1>Operator Console</h1>
          <p className="subline">Mehrtägige Agenda · OnAir-Steuerung · Beamer-ready</p>
        </div>
        <div className="onAirActions">
          <button
            type="button"
            className={onAir ? "button ghost" : "button danger"}
            onClick={onAir ? stopOnAir : startOnAir}
          >
            {onAir ? "OnAir stoppen" : "OnAir starten"}
          </button>
          <button
            type="button"
            className="button"
            onClick={advanceToNextItem}
            disabled={!onAir || nextPlannedIndex < 0}
          >
            Nächster Punkt (Space)
          </button>
        </div>
      </header>

      <section className="statusGrid">
        <article className="statusCard">
          <p>Live-Status</p>
          <strong className={onAir ? "live" : "offAir"}>{onAir ? "ON AIR" : "OFF AIR"}</strong>
        </article>
        <article className="statusCard">
          <p>Gesamtzeit seit OnAir</p>
          <strong>{formatClock(totalElapsedSec)}</strong>
        </article>
        <article className="statusCard">
          <p>Countdown aktueller TOP</p>
          <strong className={remainingSec < 0 ? "overtime" : "countdown"}>
            {currentItem ? formatSigned(remainingSec) : "--:--:--"}
          </strong>
        </article>
      </section>

      <section className="agendaArea">
        <article className="panel">
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
                    <span className="top">{item.top}</span>
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

        <article className="panel beamerStub">
          <h2>Beamer-Preview (MVP-Stub)</h2>
          <p className="hint">In der nächsten Ausbaustufe als separates Fenster.</p>
          <div className="beamerFrame">
            <p className="beamerTop">{currentItem?.top ?? "Kein aktiver TOP"}</p>
            <h3>{currentItem?.title ?? "Warten auf OnAir"}</h3>
            <p className="beamerTimer">{currentItem ? formatSigned(remainingSec) : "--:--:--"}</p>
          </div>
        </article>
      </section>
    </main>
  );
}

export default App;
