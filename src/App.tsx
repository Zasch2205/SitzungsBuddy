import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { jsPDF } from "jspdf";
import * as XLSX from "xlsx";
import logoOriginal from "./assets/sitzungsbuddy-logo-original.png";
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
  actualStartedAtMs: number | null;
  actualEndedAtMs: number | null;
  actualPausedMsTotal: number;
};

type AsRunEntry = {
  id: string;
  topLabel: string;
  startedAtMs: number;
  startedAtLabel: string;
  plannedLabel: string;
  actualLabel: string;
  isLive: boolean;
};

type AsRunFilter = "completed" | "all";

const initialAgenda: AgendaItem[] = [
  {
    id: "d1-1",
    day: "Tag 1",
    order: 1,
    top: "1",
    title: "Begrüßung und Zielsetzung",
    plannedDurationSec: 15 * 60,
    state: "planned",
    actualStartedAtMs: null,
    actualEndedAtMs: null,
    actualPausedMsTotal: 0,
  },
  {
    id: "d1-2",
    day: "Tag 1",
    order: 2,
    top: "2",
    title: "Statusberichte der Fachbereiche",
    plannedDurationSec: 45 * 60,
    state: "planned",
    actualStartedAtMs: null,
    actualEndedAtMs: null,
    actualPausedMsTotal: 0,
  },
  {
    id: "d1-3",
    day: "Tag 1",
    order: 3,
    top: "3",
    title: "Entscheidung Budget 2027",
    plannedDurationSec: 30 * 60,
    state: "planned",
    actualStartedAtMs: null,
    actualEndedAtMs: null,
    actualPausedMsTotal: 0,
  },
  {
    id: "d2-1",
    day: "Tag 2",
    order: 4,
    top: "4",
    title: "Roadmap-Planung",
    plannedDurationSec: 60 * 60,
    state: "planned",
    actualStartedAtMs: null,
    actualEndedAtMs: null,
    actualPausedMsTotal: 0,
  },
];

const movableStates: AgendaState[] = ["planned", "hold"];
const defaultMeetingDateLabel = "01. Oktober";

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

function formatTimeOfDay(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString("de-DE", { hour12: false });
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

function readCellText(sheet: XLSX.WorkSheet, address: string): string {
  const cell = sheet[address];
  if (!cell || cell.v === null || cell.v === undefined) {
    return "";
  }

  if (cell.v instanceof Date) {
    return cell.v.toLocaleDateString("de-DE");
  }

  return String(cell.v).trim();
}

function readLabeledValue(sheet: XLSX.WorkSheet, labelPattern: RegExp): string {
  for (let row = 1; row <= 25; row += 1) {
    const leftValue = readCellText(sheet, `A${row}`);
    if (!labelPattern.test(leftValue)) {
      continue;
    }

    const rightB = readCellText(sheet, `B${row}`);
    const rightC = readCellText(sheet, `C${row}`);
    return rightB || rightC;
  }

  return "";
}

function parseDurationCell(cell?: XLSX.CellObject): number | null {
  if (!cell || cell.v === null || cell.v === undefined || cell.v === "") {
    return null;
  }

  if (typeof cell.v === "number") {
    if (cell.v > 0 && cell.v < 1) {
      return Math.round(cell.v * 24 * 60 * 60);
    }

    if (cell.v >= 1 && cell.v < 1000) {
      return Math.round(cell.v * 60);
    }
  }

  const valueText = String(cell.v).trim();
  const clockMatch = valueText.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (clockMatch) {
    const hours = Number(clockMatch[1]);
    const minutes = Number(clockMatch[2]);
    const seconds = Number(clockMatch[3] ?? "0");
    return hours * 3600 + minutes * 60 + seconds;
  }

  const minutesMatch = valueText.match(/^(\d{1,4})\s*(m|min)$/i);
  if (minutesMatch) {
    return Number(minutesMatch[1]) * 60;
  }

  return null;
}

function buildImportedAgenda(sheet: XLSX.WorkSheet): AgendaItem[] {
  const imported: AgendaItem[] = [];
  let blankStreak = 0;

  for (let row = 5; row <= 600; row += 1) {
    const topValue = readCellText(sheet, `A${row}`);
    const titleValue = readCellText(sheet, `B${row}`);

    if (!topValue && !titleValue) {
      blankStreak += 1;
      if (blankStreak >= 20 && imported.length > 0) {
        break;
      }
      continue;
    }

    blankStreak = 0;

    if (!topValue || !titleValue) {
      continue;
    }

    const durationSec = parseDurationCell(sheet[`C${row}`]) ?? 15 * 60;
    const dayPrefix = topValue.split(".")[0]?.trim();

    imported.push({
      id: `import-${row}-${topValue.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      day: dayPrefix ? `Tag ${dayPrefix}` : "Tag 1",
      order: imported.length + 1,
      top: topValue,
      title: titleValue,
      plannedDurationSec: durationSec,
      state: "planned",
      actualStartedAtMs: null,
      actualEndedAtMs: null,
      actualPausedMsTotal: 0,
    });
  }

  return imported;
}

function App() {
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const [agenda, setAgenda] = useState<AgendaItem[]>(initialAgenda);
  const [onAir, setOnAir] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [pauseStartedAtMs, setPauseStartedAtMs] = useState<number | null>(null);
  const [sessionPausedMsTotal, setSessionPausedMsTotal] = useState(0);
  const [currentItemPausedMsTotal, setCurrentItemPausedMsTotal] = useState(0);
  const [sessionStoppedAtMs, setSessionStoppedAtMs] = useState<number | null>(null);
  const [currentItemStoppedAtMs, setCurrentItemStoppedAtMs] = useState<number | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [currentItemId, setCurrentItemId] = useState<string | null>(null);
  const [currentItemStartedAt, setCurrentItemStartedAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(Date.now());

  const [meetingTitle, setMeetingTitle] = useState("135. PTKO");
  const [meetingDate, setMeetingDate] = useState(defaultMeetingDateLabel);
  const [meetingLocation, setMeetingLocation] = useState("Hamburg");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTitleDraft, setSettingsTitleDraft] = useState(meetingTitle);
  const [settingsDateDraft, setSettingsDateDraft] = useState(meetingDate);
  const [settingsLocationDraft, setSettingsLocationDraft] = useState(meetingLocation);
  const [asRunFilter, setAsRunFilter] = useState<AsRunFilter>("all");
  const [importInfo, setImportInfo] = useState("");

  const currentIndex = useMemo(
    () => agenda.findIndex((item) => item.id === currentItemId),
    [agenda, currentItemId],
  );

  const currentItem = currentIndex >= 0 ? agenda[currentIndex] : null;

  const totalElapsedSec = useMemo(() => {
    if (sessionStartedAt === null) {
      return 0;
    }

    const referenceNow = onAir
      ? isPaused && pauseStartedAtMs !== null
        ? pauseStartedAtMs
        : nowMs
      : sessionStoppedAtMs ?? nowMs;

    const elapsedMs = referenceNow - sessionStartedAt - sessionPausedMsTotal;
    return Math.max(0, Math.floor(elapsedMs / 1000));
  }, [isPaused, nowMs, onAir, pauseStartedAtMs, sessionPausedMsTotal, sessionStartedAt, sessionStoppedAtMs]);

  const currentElapsedSec = useMemo(() => {
    if (currentItemStartedAt === null) {
      return 0;
    }

    const referenceNow = onAir
      ? isPaused && pauseStartedAtMs !== null
        ? pauseStartedAtMs
        : nowMs
      : currentItemStoppedAtMs ?? nowMs;

    const elapsedMs = referenceNow - currentItemStartedAt - currentItemPausedMsTotal;
    return Math.max(0, Math.floor(elapsedMs / 1000));
  }, [
    currentItemPausedMsTotal,
    currentItemStartedAt,
    currentItemStoppedAtMs,
    isPaused,
    nowMs,
    onAir,
    pauseStartedAtMs,
  ]);

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

  const asRunEntries = useMemo<AsRunEntry[]>(() => {
    return agenda
      .filter((item) => item.actualStartedAtMs !== null)
      .map((item) => {
        const startedAtMs = item.actualStartedAtMs ?? nowMs;
        const finishedAtMs = item.actualEndedAtMs ?? (item.id === currentItemId ? nowMs : startedAtMs);
        const livePauseDeltaMs =
          item.state === "live" && isPaused && pauseStartedAtMs !== null ? nowMs - pauseStartedAtMs : 0;
        const actualMs = finishedAtMs - startedAtMs - item.actualPausedMsTotal - livePauseDeltaMs;
        const actualSec = Math.max(0, Math.floor(actualMs / 1000));

        return {
          id: item.id,
          topLabel: `${item.top} ${item.title}`,
          startedAtMs,
          startedAtLabel: formatTimeOfDay(startedAtMs),
          plannedLabel: formatClock(item.plannedDurationSec),
          actualLabel: formatClock(actualSec),
          isLive: item.state === "live",
        };
      })
      .sort((left, right) => left.startedAtMs - right.startedAtMs);
  }, [agenda, currentItemId, isPaused, nowMs, pauseStartedAtMs]);

  const filteredAsRunEntries = useMemo(() => {
    if (asRunFilter === "completed") {
      return asRunEntries.filter((entry) => !entry.isLive);
    }

    return asRunEntries;
  }, [asRunEntries, asRunFilter]);

  const advanceToNextItem = useCallback(() => {
    if (!onAir || isPaused) {
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
        return {
          ...item,
          state: "done" as const,
          actualEndedAtMs: timestamp,
        };
      }

      if (item.id === nextItemId) {
        return {
          ...item,
          state: "live" as const,
          actualStartedAtMs: item.actualStartedAtMs ?? timestamp,
          actualEndedAtMs: null,
        };
      }

      return item;
    });

    setAgenda(updated);
    setCurrentItemId(nextItemId);
    setCurrentItemStartedAt(nextItemId ? timestamp : null);
    setCurrentItemPausedMsTotal(0);
    setCurrentItemStoppedAtMs(nextItemId ? null : timestamp);
    setNowMs(timestamp);
  }, [agenda, currentItemId, isPaused, onAir]);

  const startOnAir = useCallback(() => {
    if (onAir) {
      return;
    }

    const timestamp = Date.now();
    setOnAir(true);
    setIsPaused(false);
    setPauseStartedAtMs(null);
    setSessionStoppedAtMs(null);
    setNowMs(timestamp);

    if (sessionStartedAt === null) {
      setSessionStartedAt(timestamp);
      setSessionPausedMsTotal(0);
    }

    if (currentItemId !== null) {
      setCurrentItemStoppedAtMs(null);
      return;
    }

    const firstPlanned = agenda.find((item) => item.state === "planned");
    if (!firstPlanned) {
      return;
    }

    setAgenda((previous) =>
      previous.map((item) => {
        if (item.id !== firstPlanned.id) {
          return item;
        }

        return {
          ...item,
          state: "live" as const,
          actualStartedAtMs: item.actualStartedAtMs ?? timestamp,
          actualEndedAtMs: null,
        };
      }),
    );

    setCurrentItemId(firstPlanned.id);
    setCurrentItemStartedAt(timestamp);
    setCurrentItemPausedMsTotal(0);
    setCurrentItemStoppedAtMs(null);
  }, [agenda, currentItemId, onAir, sessionStartedAt]);

  const togglePauseSession = useCallback(() => {
    if (!onAir) {
      return;
    }

    const timestamp = Date.now();

    if (!isPaused) {
      setIsPaused(true);
      setPauseStartedAtMs(timestamp);
      return;
    }

    const activePauseStartedAt = pauseStartedAtMs ?? timestamp;
    const pauseDurationMs = Math.max(0, timestamp - activePauseStartedAt);

    setIsPaused(false);
    setPauseStartedAtMs(null);
    setSessionPausedMsTotal((previous) => previous + pauseDurationMs);

    if (currentItemId !== null) {
      setCurrentItemPausedMsTotal((previous) => previous + pauseDurationMs);
      setAgenda((previous) =>
        previous.map((item) => {
          if (item.id !== currentItemId) {
            return item;
          }

          return {
            ...item,
            actualPausedMsTotal: item.actualPausedMsTotal + pauseDurationMs,
          };
        }),
      );
    }
  }, [currentItemId, isPaused, onAir, pauseStartedAtMs]);

  const stopSession = useCallback(() => {
    if (!onAir && !isPaused) {
      return;
    }

    const shouldStop = window.confirm("Sitzung wirklich beenden?");
    if (!shouldStop) {
      return;
    }

    const timestamp = Date.now();
    const activePauseStartedAt = isPaused ? pauseStartedAtMs ?? timestamp : null;
    const pauseDurationMs = activePauseStartedAt ? Math.max(0, timestamp - activePauseStartedAt) : 0;

    if (pauseDurationMs > 0) {
      setSessionPausedMsTotal((previous) => previous + pauseDurationMs);

      if (currentItemId !== null) {
        setCurrentItemPausedMsTotal((previous) => previous + pauseDurationMs);
      }
    }

    setAgenda((previous) =>
      previous.map((item) => {
        if (item.id !== currentItemId || item.state !== "live") {
          return item;
        }

        return {
          ...item,
          state: "done" as const,
          actualEndedAtMs: timestamp,
          actualPausedMsTotal: item.actualPausedMsTotal + pauseDurationMs,
        };
      }),
    );

    setOnAir(false);
    setIsPaused(false);
    setPauseStartedAtMs(null);
    setSessionStoppedAtMs(timestamp);
    setCurrentItemStoppedAtMs(timestamp);
    setCurrentItemId(null);
    setCurrentItemStartedAt(null);
    setCurrentItemPausedMsTotal(0);
    setNowMs(timestamp);
  }, [currentItemId, isPaused, onAir, pauseStartedAtMs]);

  const openSettings = useCallback(() => {
    setSettingsTitleDraft(meetingTitle);
    setSettingsDateDraft(meetingDate);
    setSettingsLocationDraft(meetingLocation);
    setIsSettingsOpen(true);
  }, [meetingDate, meetingLocation, meetingTitle]);

  const closeSettings = useCallback(() => {
    setIsSettingsOpen(false);
  }, []);

  const saveSettings = useCallback(() => {
    setMeetingTitle((previous) => {
      const cleaned = settingsTitleDraft.trim();
      return cleaned.length > 0 ? cleaned : previous;
    });

    setMeetingDate((previous) => {
      const cleaned = settingsDateDraft.trim();
      return cleaned.length > 0 ? cleaned : previous;
    });

    setMeetingLocation((previous) => {
      const cleaned = settingsLocationDraft.trim();
      return cleaned.length > 0 ? cleaned : previous;
    });

    setIsSettingsOpen(false);
  }, [settingsDateDraft, settingsLocationDraft, settingsTitleDraft]);

  const triggerAgendaImport = useCallback(() => {
    importInputRef.current?.click();
  }, []);

  const handleAgendaImport = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const selectedFile = event.target.files?.[0];
      if (!selectedFile) {
        return;
      }

      try {
        const fileBuffer = await selectedFile.arrayBuffer();
        const workbook = XLSX.read(fileBuffer, { type: "array", cellDates: true });
        const firstSheetName = workbook.SheetNames[0];
        const firstSheet = firstSheetName ? workbook.Sheets[firstSheetName] : undefined;

        if (!firstSheet) {
          throw new Error("Keine Tabelle in der Datei gefunden.");
        }

        const importedAgenda = buildImportedAgenda(firstSheet);
        if (importedAgenda.length === 0) {
          throw new Error(
            "Keine TOPs gefunden. Erwartet werden TOP-Nummer in Spalte A und Titel in Spalte B ab Zeile 5.",
          );
        }

        const importedTitle = readCellText(firstSheet, "A1") || meetingTitle;
        const importedLocation = readCellText(firstSheet, "B2") || readLabeledValue(firstSheet, /ort/i) || meetingLocation;
        const importedDate =
          readCellText(firstSheet, "C2") || readLabeledValue(firstSheet, /datum|zeit/i) || meetingDate;

        setAgenda(importedAgenda);
        setMeetingTitle(importedTitle);
        setMeetingDate(importedDate);
        setMeetingLocation(importedLocation);

        setOnAir(false);
        setIsPaused(false);
        setPauseStartedAtMs(null);
        setSessionPausedMsTotal(0);
        setCurrentItemPausedMsTotal(0);
        setSessionStartedAt(null);
        setSessionStoppedAtMs(null);
        setCurrentItemId(null);
        setCurrentItemStartedAt(null);
        setCurrentItemStoppedAtMs(null);
        setAsRunFilter("all");
        setNowMs(Date.now());

        setImportInfo(`Importiert: ${selectedFile.name} (${importedAgenda.length} TOPs)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unbekannter Importfehler";
        setImportInfo(`Import fehlgeschlagen: ${message}`);
      } finally {
        event.target.value = "";
      }
    },
    [meetingDate, meetingLocation, meetingTitle],
  );

  const exportAsRunPdf = useCallback(() => {
    if (asRunEntries.length === 0) {
      window.alert("Es wurden noch keine Tagesordnungspunkte gesendet.");
      return;
    }

    const document = new jsPDF({ unit: "pt", format: "a4" });
    const margin = 42;
    const pageHeight = document.internal.pageSize.getHeight();
    const columnTop = margin;
    const columnStart = 300;
    const columnPlanned = 404;
    const columnActual = 500;
    let cursorY = 52;

    const drawTableHeader = (y: number) => {
      document.setFont("helvetica", "bold");
      document.setFontSize(11);
      document.text("TOP", columnTop, y);
      document.text("Start", columnStart, y);
      document.text("Geplant", columnPlanned, y);
      document.text("Ist", columnActual, y);
      document.setLineWidth(1);
      document.line(margin, y + 8, 554, y + 8);
      return y + 22;
    };

    document.setFont("helvetica", "bold");
    document.setFontSize(18);
    document.text("AsRun Log", margin, cursorY);

    cursorY += 22;
    document.setFont("helvetica", "normal");
    document.setFontSize(11);
    document.text(`${meetingTitle} · ${meetingDate} · ${meetingLocation}`, margin, cursorY);

    cursorY += 16;
    document.text(
      `Exportzeit: ${new Date(nowMs).toLocaleString("de-DE", { hour12: false })}`,
      margin,
      cursorY,
    );

    cursorY += 26;
    cursorY = drawTableHeader(cursorY);

    document.setFont("helvetica", "normal");
    document.setFontSize(10);

    asRunEntries.forEach((entry) => {
      if (cursorY > pageHeight - 46) {
        document.addPage();
        cursorY = drawTableHeader(52);
        document.setFont("helvetica", "normal");
        document.setFontSize(10);
      }

      const topLabel =
        entry.topLabel.length > 45 ? `${entry.topLabel.slice(0, 42).trimEnd()}…` : entry.topLabel;

      document.text(topLabel, columnTop, cursorY);
      document.text(entry.startedAtLabel, columnStart, cursorY);
      document.text(entry.plannedLabel, columnPlanned, cursorY);
      document.text(entry.actualLabel, columnActual, cursorY);

      cursorY += 18;
    });

    const stamp = new Date(nowMs).toISOString().replace(/[.:]/g, "-");
    document.save(`asrun-log-${stamp}.pdf`);
  }, [asRunEntries, meetingDate, meetingLocation, meetingTitle, nowMs]);

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
      if (event.code !== "Space" || isSettingsOpen) {
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
  }, [advanceToNextItem, isSettingsOpen]);

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsSettingsOpen(false);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isSettingsOpen]);

  const currentClockLabel = useMemo(() => {
    return new Date(nowMs).toLocaleTimeString("de-DE", { hour12: false });
  }, [nowMs]);

  const currentTopLabel = currentItem ? `${currentItem.top}. ${currentItem.title}` : "Kein aktiver TOP";

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
          <div className="leftHeaderStack">
            <div className="logoTile" aria-label="Sitzungsbuddy Logo">
              <img src={logoOriginal} alt="Sitzungsbuddy Logo" className="logoImage" />
            </div>
            <div className="dateArea">
              <p>{meetingDate}</p>
              <strong>{meetingLocation}</strong>
            </div>
          </div>

          <div className="titleArea">
            <h1>{meetingTitle}</h1>
          </div>

          <div className="sessionControlGroup">
            <button
              type="button"
              className={onAir ? "onAirButton active" : "onAirButton"}
              onClick={startOnAir}
            >
              On
              <br />
              Air
            </button>

            <div className="miniSessionButtons">
              <button
                type="button"
                className="miniSessionButton"
                onClick={togglePauseSession}
                disabled={!onAir}
                title={isPaused ? "Sitzung fortsetzen" : "Sitzung pausieren"}
                aria-label={isPaused ? "Sitzung fortsetzen" : "Sitzung pausieren"}
              >
                {isPaused ? "▶" : "❚❚"}
              </button>
              <button
                type="button"
                className="miniSessionButton"
                onClick={stopSession}
                disabled={!onAir && !isPaused}
                title="Sitzung beenden"
                aria-label="Sitzung beenden"
              >
                ■
              </button>
            </div>
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
              className="iconButton"
              aria-label="Einstellungen"
              title="Einstellungen"
              onClick={openSettings}
            >
              ⚙
            </button>
            <button
              type="button"
              className="iconButton exportButton"
              onClick={exportAsRunPdf}
              aria-label="AsRun Log als PDF exportieren"
              title="AsRun Log als PDF exportieren"
            >
              <svg className="iconSvg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <rect x="4" y="9" width="14" height="11" rx="2" />
                <path d="M13 4h7v7" />
                <path d="M20 4l-9 9" />
              </svg>
            </button>
            <button
              type="button"
              className="iconButton importButton"
              onClick={triggerAgendaImport}
              aria-label="Agenda aus Excel importieren"
              title="Agenda aus Excel importieren"
            >
              <svg className="iconSvg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M12 4v10" />
                <path d="M8 10l4 4 4-4" />
                <rect x="4" y="15" width="16" height="5" rx="1.6" />
              </svg>
            </button>
            <p className="spaceHint">Leertaste = Nächster TOP</p>
            {importInfo ? <p className="importHint">{importInfo}</p> : null}
          </aside>
        </div>
      </header>

      <input
        ref={importInputRef}
        type="file"
        accept=".xlsx,.xls"
        className="hiddenFileInput"
        onChange={handleAgendaImport}
      />

      <section className="agendaScrollArea">
        <article className="asRunCard">
          <div className="asRunHead">
            <div>
              <h2>Gesendete TOPs</h2>
              <p>Vorschau für den PDF-Export</p>
            </div>

            <div className="asRunFilter" role="group" aria-label="AsRun Filter">
              <button
                type="button"
                className={asRunFilter === "completed" ? "asRunFilterButton active" : "asRunFilterButton"}
                onClick={() => setAsRunFilter("completed")}
              >
                Nur fertige TOPs
              </button>
              <button
                type="button"
                className={asRunFilter === "all" ? "asRunFilterButton active" : "asRunFilterButton"}
                onClick={() => setAsRunFilter("all")}
              >
                inkl. laufendem TOP
              </button>
            </div>
          </div>

          {filteredAsRunEntries.length === 0 ? (
            <p className="asRunEmpty">
              {asRunEntries.length === 0
                ? "Noch keine gesendeten Tagesordnungspunkte."
                : "Aktuell keine fertigen TOPs in der Ansicht."}
            </p>
          ) : (
            <ul className="asRunList">
              {filteredAsRunEntries.map((entry) => (
                <li key={entry.id} className="asRunItem">
                  <span className="asRunTop">{entry.topLabel}</span>
                  <span className="asRunCell">Start {entry.startedAtLabel}</span>
                  <span className="asRunCell">Geplant {entry.plannedLabel}</span>
                  <span className="asRunCell">Ist {entry.actualLabel}</span>
                  <span className={entry.isLive ? "asRunBadge live" : "asRunBadge done"}>
                    {entry.isLive ? "Läuft" : "Fertig"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </article>

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

      {isSettingsOpen ? (
        <div className="settingsOverlay" onClick={closeSettings}>
          <section
            className="settingsModal"
            role="dialog"
            aria-modal="true"
            aria-label="Sitzungseinstellungen"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>Einstellungen</h3>

            <label className="settingsField" htmlFor="meeting-title-input">
              Titel der Sitzung
            </label>
            <input
              id="meeting-title-input"
              className="settingsInput"
              value={settingsTitleDraft}
              onChange={(event) => setSettingsTitleDraft(event.currentTarget.value)}
              placeholder="z. B. 135. PTKO"
            />

            <label className="settingsField" htmlFor="meeting-date-input">
              Datum
            </label>
            <input
              id="meeting-date-input"
              className="settingsInput"
              value={settingsDateDraft}
              onChange={(event) => setSettingsDateDraft(event.currentTarget.value)}
              placeholder="z. B. 01. Oktober"
            />

            <label className="settingsField" htmlFor="meeting-location-input">
              Ort
            </label>
            <input
              id="meeting-location-input"
              className="settingsInput"
              value={settingsLocationDraft}
              onChange={(event) => setSettingsLocationDraft(event.currentTarget.value)}
              placeholder="z. B. Hamburg"
            />

            <div className="settingsActions">
              <button type="button" className="settingsButton ghost" onClick={closeSettings}>
                Abbrechen
              </button>
              <button type="button" className="settingsButton" onClick={saveSettings}>
                Speichern
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

export default App;
