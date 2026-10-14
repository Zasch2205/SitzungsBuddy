import { type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { jsPDF } from "jspdf";
import * as XLSX from "xlsx";
import helpOverviewImage from "./assets/help-overview.png";
import logoOriginal from "./assets/sitzungsbuddy-logo-original.png";
import "./App.css";

type AgendaState = "planned" | "live" | "hold" | "done" | "skipped";
type AgendaKind = "topic" | "break";

type AgendaItem = {
  id: string;
  kind: AgendaKind;
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
    kind: "topic",
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
    kind: "topic",
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
    kind: "topic",
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
    kind: "topic",
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
const maxImportFileSizeBytes = 5 * 1024 * 1024;
const maxImportSheetCount = 5;
const maxImportCellCount = 20_000;
const savedSessionStorageKey = "sitzungsbuddy.saved-session.v1";

type PersistedSession = {
  savedAtMs: number;
  agenda: AgendaItem[];
  onAir: boolean;
  isPaused: boolean;
  pauseStartedAtMs: number | null;
  sessionPausedMsTotal: number;
  currentItemPausedMsTotal: number;
  sessionStoppedAtMs: number | null;
  currentItemStoppedAtMs: number | null;
  sessionStartedAt: number | null;
  currentItemId: string | null;
  currentItemStartedAt: number | null;
  meetingTitle: string;
  meetingSubtitle: string;
  meetingDate: string;
  meetingLocation: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNullableNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function readNonNegativeNumber(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return value;
}

function parseSavedAgenda(rawAgenda: unknown): AgendaItem[] | null {
  if (!Array.isArray(rawAgenda) || rawAgenda.length === 0) {
    return null;
  }

  const parsed = rawAgenda.map((rawItem, index) => {
    if (!isRecord(rawItem)) {
      return null;
    }

    const itemId = sanitizeImportedText(String(rawItem.id ?? ""), 90);
    if (!itemId) {
      return null;
    }

    const kind: AgendaKind = rawItem.kind === "break" ? "break" : "topic";
    const state: AgendaState =
      rawItem.state === "live" ||
      rawItem.state === "hold" ||
      rawItem.state === "done" ||
      rawItem.state === "skipped" ||
      rawItem.state === "planned"
        ? rawItem.state
        : "planned";

    const day = sanitizeImportedText(String(rawItem.day ?? "Tag 1"), 64) || "Tag 1";
    const topFallback = kind === "break" ? "PAUSE" : String(index + 1);
    const top = sanitizeImportedText(String(rawItem.top ?? topFallback), 64) || topFallback;
    const titleFallback = kind === "break" ? "Pause" : `TOP ${top}`;
    const title = sanitizeImportedText(String(rawItem.title ?? titleFallback), 200) || titleFallback;

    const durationSec = Math.round(readNonNegativeNumber(rawItem.plannedDurationSec, 300));
    const plannedDurationSec = Math.max(60, durationSec);

    return {
      id: itemId,
      kind,
      day,
      order: index + 1,
      top,
      title,
      plannedDurationSec,
      state,
      actualStartedAtMs: readNullableNumber(rawItem.actualStartedAtMs),
      actualEndedAtMs: readNullableNumber(rawItem.actualEndedAtMs),
      actualPausedMsTotal: readNonNegativeNumber(rawItem.actualPausedMsTotal, 0),
    } satisfies AgendaItem;
  });

  if (parsed.some((item) => item === null)) {
    return null;
  }

  const agenda = parsed as AgendaItem[];
  const uniqueIds = new Set(agenda.map((item) => item.id));
  if (uniqueIds.size !== agenda.length) {
    return null;
  }

  return agenda;
}

function parseSavedSession(rawValue: string | null): PersistedSession | null {
  if (!rawValue) {
    return null;
  }

  try {
    const parsedRaw: unknown = JSON.parse(rawValue);
    if (!isRecord(parsedRaw)) {
      return null;
    }

    const agenda = parseSavedAgenda(parsedRaw.agenda);
    if (!agenda) {
      return null;
    }

    const parsedCurrentItemId =
      typeof parsedRaw.currentItemId === "string" && agenda.some((item) => item.id === parsedRaw.currentItemId)
        ? parsedRaw.currentItemId
        : null;

    const onAir = Boolean(parsedRaw.onAir) && parsedCurrentItemId !== null;
    const isPaused = onAir ? Boolean(parsedRaw.isPaused) : false;
    const pauseStartedAtMs = isPaused ? readNullableNumber(parsedRaw.pauseStartedAtMs) : null;

    return {
      savedAtMs: readNullableNumber(parsedRaw.savedAtMs) ?? Date.now(),
      agenda,
      onAir,
      isPaused,
      pauseStartedAtMs,
      sessionPausedMsTotal: readNonNegativeNumber(parsedRaw.sessionPausedMsTotal, 0),
      currentItemPausedMsTotal: readNonNegativeNumber(parsedRaw.currentItemPausedMsTotal, 0),
      sessionStoppedAtMs: readNullableNumber(parsedRaw.sessionStoppedAtMs),
      currentItemStoppedAtMs: readNullableNumber(parsedRaw.currentItemStoppedAtMs),
      sessionStartedAt: readNullableNumber(parsedRaw.sessionStartedAt),
      currentItemId: parsedCurrentItemId,
      currentItemStartedAt: parsedCurrentItemId ? readNullableNumber(parsedRaw.currentItemStartedAt) : null,
      meetingTitle: sanitizeImportedText(String(parsedRaw.meetingTitle ?? "135. PTKO"), 120) || "135. PTKO",
      meetingSubtitle: sanitizeImportedText(String(parsedRaw.meetingSubtitle ?? ""), 160),
      meetingDate: sanitizeImportedText(String(parsedRaw.meetingDate ?? defaultMeetingDateLabel), 80) || defaultMeetingDateLabel,
      meetingLocation: sanitizeImportedText(String(parsedRaw.meetingLocation ?? "Hamburg"), 120) || "Hamburg",
    };
  } catch {
    return null;
  }
}

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

function sanitizeImportedText(rawValue: string, maxLength = 240): string {
  return rawValue
    .replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
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
    return sanitizeImportedText(cell.v.toLocaleDateString("de-DE"), 120);
  }

  return sanitizeImportedText(String(cell.v));
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

function parseDurationInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const fullClock = trimmed.match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
  if (fullClock) {
    const hours = Number(fullClock[1]);
    const minutes = Number(fullClock[2]);
    const seconds = Number(fullClock[3]);

    if (minutes >= 60 || seconds >= 60) {
      return null;
    }

    return hours * 3600 + minutes * 60 + seconds;
  }

  const hourMinuteClock = trimmed.match(/^(\d{1,3}):(\d{2})$/);
  if (hourMinuteClock) {
    const hours = Number(hourMinuteClock[1]);
    const minutes = Number(hourMinuteClock[2]);
    if (minutes >= 60) {
      return null;
    }

    return hours * 3600 + minutes * 60;
  }

  const minutesWithSuffix = trimmed.match(/^(\d{1,4})\s*(m|min)$/i);
  if (minutesWithSuffix) {
    return Number(minutesWithSuffix[1]) * 60;
  }

  const minutesOnly = trimmed.match(/^(\d{1,4})$/);
  if (minutesOnly) {
    return Number(minutesOnly[1]) * 60;
  }

  return null;
}

function parseDayLabel(dayCell: XLSX.CellObject | undefined, topValue: string): string {
  if (dayCell && dayCell.v !== null && dayCell.v !== undefined && String(dayCell.v).trim() !== "") {
    if (typeof dayCell.v === "number") {
      const dayFromNumber = Math.max(1, Math.round(dayCell.v));
      return `Tag ${dayFromNumber}`;
    }

    const dayText = String(dayCell.v).trim();
    const digitMatch = dayText.match(/(\d{1,2})/);
    if (digitMatch) {
      return `Tag ${digitMatch[1]}`;
    }

    if (/erst/i.test(dayText)) {
      return "Tag 1";
    }

    if (/zweit/i.test(dayText)) {
      return "Tag 2";
    }
  }

  const topPrefix = topValue.split(".")[0]?.trim();
  if (topPrefix && /^\d+$/.test(topPrefix)) {
    return `Tag ${topPrefix}`;
  }

  return "Tag 1";
}

function findAgendaStartRow(sheet: XLSX.WorkSheet): number {
  for (let row = 1; row <= 40; row += 1) {
    const leftValue = readCellText(sheet, `A${row}`).toLowerCase();
    const titleValue = readCellText(sheet, `B${row}`).toLowerCase();
    if (leftValue === "top" && titleValue.includes("titel")) {
      return row + 1;
    }
  }

  return 6;
}

function buildImportedAgenda(sheet: XLSX.WorkSheet): AgendaItem[] {
  const imported: AgendaItem[] = [];
  let blankStreak = 0;
  const startRow = findAgendaStartRow(sheet);

  for (let row = startRow; row <= 600; row += 1) {
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
    const dayLabel = parseDayLabel(sheet[`D${row}`], topValue);

    imported.push({
      id: `import-${row}-${topValue.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      kind: "topic",
      day: dayLabel,
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

function resolveTimerReferenceMs(options: {
  onAir: boolean;
  isPaused: boolean;
  pauseStartedAtMs: number | null;
  stoppedAtMs: number | null;
  nowMs: number;
}): number {
  if (options.onAir) {
    if (options.isPaused && options.pauseStartedAtMs !== null) {
      return options.pauseStartedAtMs;
    }

    return options.nowMs;
  }

  return options.stoppedAtMs ?? options.nowMs;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function ensurePdfExtension(path: string): string {
  return path.toLowerCase().endsWith(".pdf") ? path : `${path}.pdf`;
}

function App() {
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const appVersion = __APP_VERSION__;

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
  const [meetingSubtitle, setMeetingSubtitle] = useState("");
  const [meetingDate, setMeetingDate] = useState(defaultMeetingDateLabel);
  const [meetingLocation, setMeetingLocation] = useState("Hamburg");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isStopConfirmOpen, setIsStopConfirmOpen] = useState(false);
  const [settingsTitleDraft, setSettingsTitleDraft] = useState(meetingTitle);
  const [settingsDateDraft, setSettingsDateDraft] = useState(meetingDate);
  const [settingsLocationDraft, setSettingsLocationDraft] = useState(meetingLocation);
  const [asRunFilter, setAsRunFilter] = useState<AsRunFilter>("all");
  const [importInfo, setImportInfo] = useState("");
  const [editingDurationItemId, setEditingDurationItemId] = useState<string | null>(null);
  const [editingDurationValue, setEditingDurationValue] = useState("");
  const [editingTitleItemId, setEditingTitleItemId] = useState<string | null>(null);
  const [editingTitleValue, setEditingTitleValue] = useState("");
  const [savedSessionCandidate, setSavedSessionCandidate] = useState<PersistedSession | null>(null);

  const currentIndex = useMemo(
    () => agenda.findIndex((item) => item.id === currentItemId),
    [agenda, currentItemId],
  );

  const currentItem = currentIndex >= 0 ? agenda[currentIndex] : null;

  const nextItemId = useMemo(() => {
    const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
    const nextPlanned = agenda.find((item, index) => index >= startIndex && item.state === "planned");
    return nextPlanned?.id ?? null;
  }, [agenda, currentIndex]);

  const totalElapsedSec = useMemo(() => {
    if (sessionStartedAt === null) {
      return 0;
    }

    const referenceNow = resolveTimerReferenceMs({
      onAir,
      isPaused,
      pauseStartedAtMs,
      stoppedAtMs: sessionStoppedAtMs,
      nowMs,
    });

    const elapsedMs = referenceNow - sessionStartedAt - sessionPausedMsTotal;
    return Math.max(0, Math.floor(elapsedMs / 1000));
  }, [isPaused, nowMs, onAir, pauseStartedAtMs, sessionPausedMsTotal, sessionStartedAt, sessionStoppedAtMs]);

  const currentElapsedSec = useMemo(() => {
    if (currentItemStartedAt === null) {
      return 0;
    }

    const referenceNow = resolveTimerReferenceMs({
      onAir,
      isPaused,
      pauseStartedAtMs,
      stoppedAtMs: currentItemStoppedAtMs,
      nowMs,
    });

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
          topLabel: item.kind === "break" ? item.title || "Pause" : `${item.top} ${item.title}`,
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

  const clearSavedSession = useCallback(() => {
    try {
      window.localStorage.removeItem(savedSessionStorageKey);
    } catch {
      // ignore storage errors
    }
  }, []);

  const persistSessionSnapshot = useCallback((snapshot: PersistedSession): boolean => {
    try {
      window.localStorage.setItem(savedSessionStorageKey, JSON.stringify(snapshot));
      return true;
    } catch {
      window.alert("Sitzungsstand konnte nicht gespeichert werden.");
      return false;
    }
  }, []);

  const restoreSavedSession = useCallback(() => {
    if (!savedSessionCandidate) {
      return;
    }

    setAgenda(normalizeOrder(savedSessionCandidate.agenda));
    setOnAir(savedSessionCandidate.onAir);
    setIsPaused(savedSessionCandidate.isPaused);
    setPauseStartedAtMs(savedSessionCandidate.pauseStartedAtMs);
    setSessionPausedMsTotal(savedSessionCandidate.sessionPausedMsTotal);
    setCurrentItemPausedMsTotal(savedSessionCandidate.currentItemPausedMsTotal);
    setSessionStoppedAtMs(savedSessionCandidate.sessionStoppedAtMs);
    setCurrentItemStoppedAtMs(savedSessionCandidate.currentItemStoppedAtMs);
    setSessionStartedAt(savedSessionCandidate.sessionStartedAt);
    setCurrentItemId(savedSessionCandidate.currentItemId);
    setCurrentItemStartedAt(savedSessionCandidate.currentItemStartedAt);
    setMeetingTitle(savedSessionCandidate.meetingTitle);
    setMeetingSubtitle(savedSessionCandidate.meetingSubtitle);
    setMeetingDate(savedSessionCandidate.meetingDate);
    setMeetingLocation(savedSessionCandidate.meetingLocation);
    setSettingsTitleDraft(savedSessionCandidate.meetingTitle);
    setSettingsDateDraft(savedSessionCandidate.meetingDate);
    setSettingsLocationDraft(savedSessionCandidate.meetingLocation);
    setNowMs(Date.now());
    setImportInfo(`Gespeicherter Stand vom ${new Date(savedSessionCandidate.savedAtMs).toLocaleString("de-DE")} geladen.`);
    setSavedSessionCandidate(null);
    clearSavedSession();
  }, [clearSavedSession, savedSessionCandidate]);

  const dismissSavedSession = useCallback(() => {
    clearSavedSession();
    setSavedSessionCandidate(null);
  }, [clearSavedSession]);

  useEffect(() => {
    let rawValue: string | null = null;

    try {
      rawValue = window.localStorage.getItem(savedSessionStorageKey);
    } catch {
      return;
    }

    if (!rawValue) {
      return;
    }

    const parsed = parseSavedSession(rawValue);
    if (!parsed) {
      clearSavedSession();
      return;
    }

    setSavedSessionCandidate(parsed);
  }, [clearSavedSession]);

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

  const rewindToPreviousItem = useCallback(() => {
    if (!onAir || isPaused) {
      return;
    }

    const timestamp = Date.now();
    const currentIndexInAgenda = currentItemId
      ? agenda.findIndex((item) => item.id === currentItemId)
      : agenda.length;

    let previousDoneIndex = -1;
    for (let index = currentIndexInAgenda - 1; index >= 0; index -= 1) {
      if (agenda[index].state === "done") {
        previousDoneIndex = index;
        break;
      }
    }

    if (previousDoneIndex < 0) {
      return;
    }

    const previousItem = agenda[previousDoneIndex];

    const updated = agenda.map((item, index) => {
      if (index === previousDoneIndex) {
        return {
          ...item,
          state: "live" as const,
          actualEndedAtMs: null,
        };
      }

      if (item.id === currentItemId && item.state === "live") {
        return {
          ...item,
          state: "planned" as const,
          actualStartedAtMs: null,
          actualEndedAtMs: null,
          actualPausedMsTotal: 0,
        };
      }

      return item;
    });

    setAgenda(updated);
    setCurrentItemId(previousItem.id);
    setCurrentItemStartedAt(previousItem.actualStartedAtMs ?? timestamp);
    setCurrentItemPausedMsTotal(previousItem.actualPausedMsTotal);
    setCurrentItemStoppedAtMs(null);
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

    setIsStopConfirmOpen(true);
  }, [isPaused, onAir]);

  const cancelStopSession = useCallback(() => {
    setIsStopConfirmOpen(false);
  }, []);

  const confirmStopSession = useCallback((saveAfterStop: boolean) => {
    if (!onAir && !isPaused) {
      setIsStopConfirmOpen(false);
      return;
    }

    const timestamp = Date.now();
    const activePauseStartedAt = isPaused ? pauseStartedAtMs ?? timestamp : null;
    const pauseDurationMs = activePauseStartedAt ? Math.max(0, timestamp - activePauseStartedAt) : 0;
    const nextSessionPausedMsTotal = sessionPausedMsTotal + pauseDurationMs;

    const updatedAgenda = agenda.map((item) => {
      if (item.id !== currentItemId || item.state !== "live") {
        return item;
      }

      return {
        ...item,
        state: "done" as const,
        actualEndedAtMs: timestamp,
        actualPausedMsTotal: item.actualPausedMsTotal + pauseDurationMs,
      };
    });

    setAgenda(updatedAgenda);
    setSessionPausedMsTotal(nextSessionPausedMsTotal);

    setOnAir(false);
    setIsPaused(false);
    setPauseStartedAtMs(null);
    setSessionStoppedAtMs(timestamp);
    setCurrentItemStoppedAtMs(timestamp);
    setCurrentItemId(null);
    setCurrentItemStartedAt(null);
    setCurrentItemPausedMsTotal(0);
    setNowMs(timestamp);
    setIsStopConfirmOpen(false);

    if (saveAfterStop) {
      const snapshot: PersistedSession = {
        savedAtMs: timestamp,
        agenda: updatedAgenda,
        onAir: false,
        isPaused: false,
        pauseStartedAtMs: null,
        sessionPausedMsTotal: nextSessionPausedMsTotal,
        currentItemPausedMsTotal: 0,
        sessionStoppedAtMs: timestamp,
        currentItemStoppedAtMs: timestamp,
        sessionStartedAt,
        currentItemId: null,
        currentItemStartedAt: null,
        meetingTitle,
        meetingSubtitle,
        meetingDate,
        meetingLocation,
      };

      const saved = persistSessionSnapshot(snapshot);
      if (saved) {
        setImportInfo(`Stand gespeichert (${new Date(timestamp).toLocaleString("de-DE")}).`);
      }
    } else {
      clearSavedSession();
    }
  }, [
    agenda,
    clearSavedSession,
    currentItemId,
    isPaused,
    meetingDate,
    meetingLocation,
    meetingSubtitle,
    meetingTitle,
    onAir,
    pauseStartedAtMs,
    persistSessionSnapshot,
    sessionPausedMsTotal,
    sessionStartedAt,
  ]);

  const openSettings = useCallback(() => {
    setSettingsTitleDraft(meetingTitle);
    setSettingsDateDraft(meetingDate);
    setSettingsLocationDraft(meetingLocation);
    setIsSettingsOpen(true);
  }, [meetingDate, meetingLocation, meetingTitle]);

  const closeSettings = useCallback(() => {
    setIsSettingsOpen(false);
  }, []);

  const openHelp = useCallback(() => {
    setIsHelpOpen(true);
  }, []);

  const closeHelp = useCallback(() => {
    setIsHelpOpen(false);
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

      if (!selectedFile.name.toLowerCase().endsWith(".xlsx")) {
        setImportInfo("Import fehlgeschlagen: Bitte eine .xlsx-Datei auswählen.");
        event.target.value = "";
        return;
      }

      if (selectedFile.size > maxImportFileSizeBytes) {
        setImportInfo("Import fehlgeschlagen: Datei ist zu groß (maximal 5 MB).");
        event.target.value = "";
        return;
      }

      try {
        const fileBuffer = await selectedFile.arrayBuffer();
        const workbook = XLSX.read(fileBuffer, { type: "array", cellDates: true });

        if (workbook.SheetNames.length === 0 || workbook.SheetNames.length > maxImportSheetCount) {
          throw new Error("Workbook hat ungültige Anzahl Tabellen.");
        }

        const firstSheetName = workbook.SheetNames[0];
        const firstSheet = firstSheetName ? workbook.Sheets[firstSheetName] : undefined;

        if (!firstSheet) {
          throw new Error("Keine Tabelle in der Datei gefunden.");
        }

        const sheetRef = firstSheet["!ref"];
        if (!sheetRef) {
          throw new Error("Ungültiger Tabellenbereich.");
        }

        const range = XLSX.utils.decode_range(sheetRef);
        const rowCount = range.e.r - range.s.r + 1;
        const colCount = range.e.c - range.s.c + 1;
        if (rowCount * colCount > maxImportCellCount) {
          throw new Error("Tabelle ist zu groß.");
        }

        const importedAgenda = buildImportedAgenda(firstSheet);
        if (importedAgenda.length === 0) {
          throw new Error(
            "Keine TOPs gefunden. Erwartet werden TOP in A, Titel in B, Dauer in C und Tag in D (ab Zeile 6).",
          );
        }

        const importedTitle = sanitizeImportedText(readCellText(firstSheet, "A1"), 80) || meetingTitle;
        const importedSubtitle = sanitizeImportedText(readCellText(firstSheet, "A4"), 160);
        const importedLocation =
          sanitizeImportedText(readCellText(firstSheet, "B2"), 80) ||
          sanitizeImportedText(readLabeledValue(firstSheet, /ort/i), 80) ||
          meetingLocation;
        const importedDate =
          sanitizeImportedText(readCellText(firstSheet, "C2"), 80) ||
          sanitizeImportedText(readLabeledValue(firstSheet, /datum|zeit/i), 80) ||
          meetingDate;

        setAgenda(importedAgenda);
        setMeetingTitle(importedTitle);
        setMeetingSubtitle(importedSubtitle);
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
        setEditingDurationItemId(null);
        setEditingDurationValue("");
        setAsRunFilter("all");
        setNowMs(Date.now());

        setImportInfo(`Import erfolgreich (${importedAgenda.length} TOPs).`);
      } catch (error) {
        console.error("Agenda import failed", error);
        setImportInfo("Import fehlgeschlagen. Bitte Datei und Format prüfen (A=TOP, B=Titel, C=Dauer, D=Tag).");
      } finally {
        event.target.value = "";
      }
    },
    [meetingDate, meetingLocation, meetingTitle],
  );

  const exportAsRunPdf = useCallback(async () => {
    if (asRunEntries.length === 0) {
      window.alert("Es wurden noch keine Tagesordnungspunkte gesendet.");
      return;
    }

    const pdfDocument = new jsPDF({ unit: "pt", format: "a4" });
    const margin = 42;
    const pageHeight = pdfDocument.internal.pageSize.getHeight();
    const columnTop = margin;
    const columnStart = 300;
    const columnPlanned = 404;
    const columnActual = 500;
    let cursorY = 52;

    const drawTableHeader = (y: number) => {
      pdfDocument.setFont("helvetica", "bold");
      pdfDocument.setFontSize(11);
      pdfDocument.text("TOP", columnTop, y);
      pdfDocument.text("Start", columnStart, y);
      pdfDocument.text("Geplant", columnPlanned, y);
      pdfDocument.text("Ist", columnActual, y);
      pdfDocument.setLineWidth(1);
      pdfDocument.line(margin, y + 8, 554, y + 8);
      return y + 22;
    };

    pdfDocument.setFont("helvetica", "bold");
    pdfDocument.setFontSize(22);
    pdfDocument.text("Sitzungsbuddy - AsRunLog", margin, cursorY);

    cursorY += 15;
    pdfDocument.setFont("helvetica", "normal");
    pdfDocument.setFontSize(10);
    pdfDocument.text("Sascha Molina, (c) 2026", margin, cursorY);

    cursorY += 22;
    pdfDocument.setFont("helvetica", "normal");
    pdfDocument.setFontSize(11);
    pdfDocument.text(`${meetingTitle} · ${meetingDate} · ${meetingLocation}`, margin, cursorY);

    cursorY += 16;
    pdfDocument.text(
      `Exportzeit: ${new Date(nowMs).toLocaleString("de-DE", { hour12: false })}`,
      margin,
      cursorY,
    );

    cursorY += 26;
    cursorY = drawTableHeader(cursorY);

    pdfDocument.setFont("helvetica", "normal");
    pdfDocument.setFontSize(10);

    asRunEntries.forEach((entry) => {
      if (cursorY > pageHeight - 46) {
        pdfDocument.addPage();
        cursorY = drawTableHeader(52);
        pdfDocument.setFont("helvetica", "normal");
        pdfDocument.setFontSize(10);
      }

      const topLabel =
        entry.topLabel.length > 45 ? `${entry.topLabel.slice(0, 42).trimEnd()}…` : entry.topLabel;

      pdfDocument.text(topLabel, columnTop, cursorY);
      pdfDocument.text(entry.startedAtLabel, columnStart, cursorY);
      pdfDocument.text(entry.plannedLabel, columnPlanned, cursorY);
      pdfDocument.text(entry.actualLabel, columnActual, cursorY);

      cursorY += 18;
    });

    const stamp = new Date(nowMs).toISOString().replace(/[.:]/g, "-");
    const defaultFileName = `asrun-log-${stamp}.pdf`;

    try {
      if (!("__TAURI_INTERNALS__" in window)) {
        pdfDocument.save(defaultFileName);
        return;
      }

      const selectedPath = await save({
        title: "AsRun Log speichern",
        defaultPath: defaultFileName,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });

      if (!selectedPath) {
        return;
      }

      const targetPath = ensurePdfExtension(selectedPath);
      const pdfBuffer = pdfDocument.output("arraybuffer") as ArrayBuffer;
      await invoke("save_pdf_file", {
        path: targetPath,
        base64Data: arrayBufferToBase64(pdfBuffer),
      });
    } catch (error) {
      console.error("PDF export failed", error);
      window.alert("PDF konnte nicht gespeichert werden.");
    }
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

  const insertBreakAfterNextItem = useCallback(() => {
    const timestamp = Date.now();

    setAgenda((previous) => {
      const currentIndexInPrevious = currentItemId
        ? previous.findIndex((item) => item.id === currentItemId)
        : -1;

      const searchStart = currentIndexInPrevious >= 0 ? currentIndexInPrevious + 1 : 0;
      const nextIndex = previous.findIndex(
        (item, index) => index >= searchStart && (item.state === "planned" || item.state === "hold"),
      );

      const insertAt = nextIndex >= 0 ? nextIndex + 1 : previous.length;
      const anchorItem = previous[Math.max(0, insertAt - 1)];

      const breakItem: AgendaItem = {
        id: `pause-${timestamp}-${Math.floor(Math.random() * 10000)}`,
        kind: "break",
        day: anchorItem?.day ?? "Tag 1",
        order: 0,
        top: "PAUSE",
        title: "Pause",
        plannedDurationSec: 5 * 60,
        state: "planned",
        actualStartedAtMs: null,
        actualEndedAtMs: null,
        actualPausedMsTotal: 0,
      };

      const updated = [...previous.slice(0, insertAt), breakItem, ...previous.slice(insertAt)];
      return normalizeOrder(updated);
    });

    setImportInfo("Pause (05:00) wurde eingefügt.");
  }, [currentItemId]);

  const beginDurationEdit = useCallback((item: AgendaItem) => {
    if (item.state !== "planned" && item.state !== "hold") {
      return;
    }

    setEditingTitleItemId(null);
    setEditingTitleValue("");
    setEditingDurationItemId(item.id);
    setEditingDurationValue(formatClock(item.plannedDurationSec));
  }, []);

  const cancelDurationEdit = useCallback(() => {
    setEditingDurationItemId(null);
    setEditingDurationValue("");
  }, []);

  const commitDurationEdit = useCallback(
    (itemId: string) => {
      if (editingDurationItemId !== itemId) {
        return;
      }

      const parsedDurationSec = parseDurationInput(editingDurationValue);
      if (parsedDurationSec === null || parsedDurationSec <= 0) {
        window.alert("Ungültige Dauer. Bitte z. B. 00:15:00 oder 15 eingeben.");
        return;
      }

      setAgenda((previous) =>
        previous.map((item) => {
          if (item.id !== itemId) {
            return item;
          }

          if (item.state !== "planned" && item.state !== "hold") {
            return item;
          }

          return {
            ...item,
            plannedDurationSec: parsedDurationSec,
          };
        }),
      );

      setEditingDurationItemId(null);
      setEditingDurationValue("");
    },
    [editingDurationItemId, editingDurationValue],
  );

  const handleDurationInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>, itemId: string) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitDurationEdit(itemId);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        cancelDurationEdit();
      }
    },
    [cancelDurationEdit, commitDurationEdit],
  );

  const beginTitleEdit = useCallback((item: AgendaItem) => {
    if (item.state !== "planned" && item.state !== "hold") {
      return;
    }

    setEditingDurationItemId(null);
    setEditingDurationValue("");
    setEditingTitleItemId(item.id);
    setEditingTitleValue(item.title || "");
  }, []);

  const cancelTitleEdit = useCallback(() => {
    setEditingTitleItemId(null);
    setEditingTitleValue("");
  }, []);

  const commitTitleEdit = useCallback(
    (itemId: string) => {
      if (editingTitleItemId !== itemId) {
        return;
      }

      const sanitizedTitle = sanitizeImportedText(editingTitleValue, 180);
      if (!sanitizedTitle) {
        window.alert("Ungültiger Text. Bitte einen Titel eingeben.");
        return;
      }

      setAgenda((previous) =>
        previous.map((item) => {
          if (item.id !== itemId) {
            return item;
          }

          if (item.state !== "planned" && item.state !== "hold") {
            return item;
          }

          return {
            ...item,
            title: sanitizedTitle,
          };
        }),
      );

      setEditingTitleItemId(null);
      setEditingTitleValue("");
    },
    [editingTitleItemId, editingTitleValue],
  );

  const handleTitleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>, itemId: string) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitTitleEdit(itemId);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        cancelTitleEdit();
      }
    },
    [cancelTitleEdit, commitTitleEdit],
  );

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 250);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || isSettingsOpen || isStopConfirmOpen || isHelpOpen || savedSessionCandidate !== null) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName)) {
        return;
      }

      event.preventDefault();

      if (event.ctrlKey) {
        rewindToPreviousItem();
        return;
      }

      advanceToNextItem();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [advanceToNextItem, isHelpOpen, isSettingsOpen, isStopConfirmOpen, rewindToPreviousItem, savedSessionCandidate]);

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

  useEffect(() => {
    if (!isStopConfirmOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsStopConfirmOpen(false);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isStopConfirmOpen]);

  useEffect(() => {
    if (!isHelpOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsHelpOpen(false);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isHelpOpen]);

  useEffect(() => {
    if (!savedSessionCandidate) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismissSavedSession();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [dismissSavedSession, savedSessionCandidate]);

  const currentClockLabel = useMemo(() => {
    return new Date(nowMs).toLocaleTimeString("de-DE", { hour12: false });
  }, [nowMs]);

  const currentTopLabel = currentItem
    ? currentItem.kind === "break"
      ? currentItem.title || "Pause"
      : `${currentItem.top}. ${currentItem.title}`
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

  const pausedValueBoxClass = isPaused ? "valueBox pausedBlink" : "valueBox";

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
            {meetingSubtitle ? <p className="meetingSubtitle">{meetingSubtitle}</p> : null}
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
            <div className={pausedValueBoxClass}>{formatClock(totalElapsedSec)}</div>

            <p className={`deltaValue ${prognosisClass}`}>{prognosisLabel}</p>
          </section>

          <section className="statusColumn rightColumn">
            <p className="fieldLabel">Aktueller TOP</p>
            <div className="topBox">{currentTopLabel}</div>

            <p className="fieldLabel">Zeit des TOP</p>
            <div className={pausedValueBoxClass}>{currentItem ? formatClock(currentElapsedSec) : "--:--:--"}</div>

            <p className={`deltaValue ${countdownClass}`}>{countdownLabel}</p>
          </section>

          <aside className="actionColumn">
            <div className="actionButtonRow">
              <button
                type="button"
                className="iconButton pauseInsertButton"
                onClick={insertBreakAfterNextItem}
                aria-label="Pause unter der nächsten Position einfügen"
                title="Pause unter der nächsten Position einfügen"
              >
                ⏸+
              </button>

              <div className="actionMainButtons">
                <button
                  type="button"
                  className="iconButton settingsIconButton"
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
              </div>
            </div>
            <p className="spaceHint">Leertaste = Nächster TOP · Strg+Leertaste = Zurück</p>
            {importInfo ? <p className="importHint">{importInfo}</p> : null}
          </aside>
        </div>
      </header>

      <input
        ref={importInputRef}
        type="file"
        accept=".xlsx"
        className="hiddenFileInput"
        onChange={handleAgendaImport}
      />

      <section className="agendaScrollArea">
        <article className="agendaCard">
          <h2>Agenda</h2>
          <p className="hint">Zukünftige Punkte lassen sich umsortieren, auf Halt setzen und per Doppelklick Text/Zeit anpassen.</p>
          <ul className="agendaList">
            {agenda.map((item, index) => {
              const isCurrent = item.id === currentItemId;
              const isNext = item.id === nextItemId;
              const isFinished = item.state === "done" || item.state === "skipped";
              const isBreakItem = item.kind === "break";
              const isEditableDuration = item.state === "planned" || item.state === "hold";
              const isEditableTitle = item.state === "planned" || item.state === "hold";
              const isEditingDuration = editingDurationItemId === item.id;
              const isEditingTitle = editingTitleItemId === item.id;
              const isFuture = currentIndex < 0 || index > currentIndex;
              const canMoveUp = isFuture && index > 0;
              const canMoveDown = isFuture && index < agenda.length - 1;
              const canToggleHold = isFuture && (item.state === "planned" || item.state === "hold");
              const agendaItemClassName = [
                "agendaItem",
                isBreakItem ? "pauseItem" : "",
                isCurrent ? "current" : "",
                isNext ? "next" : "",
                isFinished ? "finished" : "",
              ]
                .filter(Boolean)
                .join(" ");

              const titleElement = isEditingTitle ? (
                <input
                  className="titleInput"
                  value={editingTitleValue}
                  onChange={(event) => setEditingTitleValue(event.currentTarget.value)}
                  onBlur={() => commitTitleEdit(item.id)}
                  onKeyDown={(event) => handleTitleInputKeyDown(event, item.id)}
                  autoFocus
                  aria-label={`Text für Zeile ${item.order} bearbeiten`}
                />
              ) : (
                <span
                  className={isEditableTitle ? "title editable" : "title"}
                  onDoubleClick={isEditableTitle ? () => beginTitleEdit(item) : undefined}
                  title={isEditableTitle ? "Doppelklick zum Bearbeiten" : "Gesendete TOPs sind gesperrt"}
                >
                  {item.title}
                </span>
              );

              return (
                <li key={item.id} className={agendaItemClassName}>
                  <div className="agendaMeta">
                    {isBreakItem ? (
                      <>
                        <span className={`badge state-${item.state}`}>Pause</span>
                        <span className="order">#{item.order}</span>
                        <span className="day">{item.day}</span>
                        {titleElement}
                      </>
                    ) : (
                      <>
                        <span className={`badge state-${item.state}`}>{stateLabel(item.state)}</span>
                        <span className="order">#{item.order}</span>
                        <span className="day">{item.day}</span>
                        <span className="top">TOP {item.top}</span>
                        {titleElement}
                      </>
                    )}
                  </div>
                  <div className="agendaActions">
                    {isEditingDuration ? (
                      <input
                        className="durationInput"
                        value={editingDurationValue}
                        onChange={(event) => setEditingDurationValue(event.currentTarget.value)}
                        onBlur={() => commitDurationEdit(item.id)}
                        onKeyDown={(event) => handleDurationInputKeyDown(event, item.id)}
                        autoFocus
                        aria-label={`Dauer für TOP ${item.top} bearbeiten`}
                      />
                    ) : (
                      <span
                        className={isEditableDuration ? "duration editable" : "duration"}
                        onDoubleClick={isEditableDuration ? () => beginDurationEdit(item) : undefined}
                        title={isEditableDuration ? "Doppelklick zum Bearbeiten" : "Gesendete TOPs sind gesperrt"}
                      >
                        {formatClock(item.plannedDurationSec)}
                      </span>
                    )}
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

            <div className="settingsImprint">
              <p className="settingsImprintTitle">Impressum (Angaben gemäß § 5 TMG)</p>
              <p>
                <strong>Diensteanbieter:</strong> Sascha Molina
              </p>
              <p>
                <strong>Kontakt:</strong> s.molina@gmx.de
              </p>
              <p>
                <strong>Verantwortlich für Inhalte nach § 18 Abs. 2 MStV:</strong> Sascha Molina
              </p>
              <p>
                <strong>Urheberrecht:</strong> Inhalte und Quellcode dieser Anwendung sind urheberrechtlich geschützt.
              </p>
              <p>
                <strong>Haftungshinweis:</strong> Trotz sorgfältiger Entwicklung wird keine Gewähr für Vollständigkeit,
                Richtigkeit und Verfügbarkeit übernommen.
              </p>
              <p>
                <strong>Stand:</strong> Oktober 2026
              </p>
              <div className="settingsVersionBlock">
                <p className="settingsVersionTitle">Sitzungsbuddy</p>
                <p className="settingsVersionLine">
                  Version <strong className="settingsVersionNumber">{appVersion}</strong>
                </p>
              </div>
            </div>

            <div className="settingsActions">
              <button type="button" className="settingsButton ghost" onClick={openHelp}>
                Hilfe
              </button>
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

      {isHelpOpen ? (
        <div className="settingsOverlay" onClick={closeHelp}>
          <section
            className="settingsModal helpModal"
            role="dialog"
            aria-modal="true"
            aria-label="Sitzungsbuddy Hilfe"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>Hilfe: Sitzungsbuddy bedienen</h3>
            <p className="helpIntro">
              Der Sitzungsbuddy ist eine App, die helfen soll sehr dynamische Sitzungen zu planen und zu leiten. Die Agenda
              kann per Excel importiert werden und dann live getriggert werden. So kann die aktuelle Zeit der einzelnen
              Positionen und die Gesamtzeit der Sitzung perfekt geplant werden. Außerdem können Positionen sehr frei
              verschoben werden, um so auch in sehr dynamischen Sitzungen den Ablauf für alle Teilnehmenden sehr transparent
              und übersichtlich zu machen.
            </p>

            <img src={helpOverviewImage} alt="Übersicht der Sitzungsbuddy Oberfläche" className="helpImage" />
            <p className="helpCaption">Aktueller Screenshot der Oberfläche (Version {appVersion}).</p>

            <h4 className="helpSectionTitle">1) Kopfbereich</h4>
            <p className="helpText">
              Oben links stehen Datum und Ort. In der Mitte stehen Haupttitel und Untertitel der Sitzung (Untertitel kommt aus
              Excel-Zelle A4). Unter der Trennlinie zeigt die linke Seite aktuelle Uhrzeit, Sitzungszeit und Prognose. Rechts
              siehst du den aktiven TOP, die laufende TOP-Zeit und den Countdown zur geplanten Dauer.
            </p>

            <h4 className="helpSectionTitle">2) Session-Steuerung</h4>
            <p className="helpText">
              <strong>OnAir</strong> startet bzw. setzt die Sitzung fort. <strong>Pause (❚❚/▶)</strong> hält alle Zeiten an;
              währenddessen blinken Sitzungszeit und TOP-Zeit im Sekundentakt. <strong>Stop (■)</strong> öffnet einen
              Sicherheitsdialog mit den Optionen <strong>Nein</strong>, <strong>Ja, ohne Speichern</strong> und
              <strong>Ja + Speichern</strong>.
            </p>

            <h4 className="helpSectionTitle">3) Rechte Funktionsknöpfe</h4>
            <p className="helpText">
              <strong>Pause einfügen (⏸+)</strong> legt unter dem nächsten offenen Punkt eine zusätzliche Pausenzeile mit
              Standarddauer 05:00 an. <strong>Zahnrad</strong> öffnet Einstellungen, Impressum und Hilfe.
              <strong> Export</strong> erzeugt ein AsRun-Log als PDF (mit Dateidialog). <strong>Import</strong> lädt eine
              Agenda aus Excel (.xlsx).
            </p>

            <h4 className="helpSectionTitle">4) Agenda-Liste</h4>
            <p className="helpText">
              Der aktuelle TOP ist gelb/grün markiert, der nächste TOP orange. Bereits gesendete Einträge werden ausgegraut.
              Zukünftige Einträge lassen sich mit den Pfeilen umsortieren und über <strong>Halt</strong> temporär sperren.
              Pausenzeilen sind leuchtend gelb dargestellt und verhalten sich wie normale Agendaeinträge.
            </p>

            <h4 className="helpSectionTitle">5) Text- und Zeitbearbeitung</h4>
            <p className="helpText">
              Bei zukünftigen bzw. gehaltenen Punkten kannst du mit Doppelklick den <strong>Titeltext</strong> und die
              <strong> geplante Dauer</strong> direkt in der Liste bearbeiten (Enter = übernehmen, Esc = abbrechen). Das gilt
              auch für eingefügte Pausenzeilen.
            </p>

            <h4 className="helpSectionTitle">6) Triggern per Tastatur</h4>
            <p className="helpText">
              <strong>Leertaste</strong> triggert vorwärts zum nächsten TOP. <strong>Strg + Leertaste</strong> nimmt das letzte
              Triggern zurück und holt den vorherigen TOP wieder auf Sendung. <strong>Esc</strong> schließt geöffnete Dialoge.
            </p>

            <h4 className="helpSectionTitle">7) Excel-Import</h4>
            <p className="helpText">
              Beim Import werden folgende Felder gelesen: <strong>A1</strong> Haupttitel, <strong>A4</strong> Untertitel,
              <strong> B2</strong> Ort, <strong>C2</strong> Datum/Zeit. TOP-Daten beginnen ab Zeile 6:
              <strong> A</strong> = TOP-Nummer, <strong>B</strong> = Titel, <strong>C</strong> = geplante Minuten,
              <strong> D</strong> = Sitzungstag.
            </p>

            <h4 className="helpSectionTitle">8) AsRun-Export</h4>
            <p className="helpText">
              Das PDF enthält alle bereits gesendeten Einträge inklusive Startzeit, geplanter Dauer und Ist-Dauer. Über die
              Filter oberhalb der Vorschau kannst du zwischen "nur fertige" und "inkl. laufendem" Eintrag wechseln.
            </p>

            <h4 className="helpSectionTitle">9) Sitzung speichern und fortführen</h4>
            <p className="helpText">
              Wenn du bei <strong>Stop</strong> "Ja + Speichern" wählst, wird der aktuelle Stand lokal gesichert. Beim nächsten
              Start fragt die App automatisch, ob der letzte Stand fortgeführt werden soll.
            </p>

            <div className="settingsActions">
              <button type="button" className="settingsButton" onClick={closeHelp}>
                Schließen
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {savedSessionCandidate ? (
        <div className="settingsOverlay" onClick={dismissSavedSession}>
          <section
            className="settingsModal resumePromptModal"
            role="dialog"
            aria-modal="true"
            aria-label="Gespeicherten Sitzungsstand laden"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>Gespeicherten Stand fortführen?</h3>
            <p className="stopConfirmText">
              Es gibt einen gespeicherten Sitzungsstand vom {new Date(savedSessionCandidate.savedAtMs).toLocaleString("de-DE")}
              . Soll dieser Stand geladen und fortgeführt werden?
            </p>
            <div className="settingsActions">
              <button type="button" className="settingsButton ghost" onClick={dismissSavedSession}>
                Nein
              </button>
              <button type="button" className="settingsButton" onClick={restoreSavedSession}>
                Ja, fortführen
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {isStopConfirmOpen ? (
        <div className="settingsOverlay" onClick={cancelStopSession}>
          <section
            className="settingsModal stopConfirmModal"
            role="dialog"
            aria-modal="true"
            aria-label="Sitzung beenden"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>Sitzung beenden?</h3>
            <p className="stopConfirmText">Soll die laufende Sitzung beendet werden? Optional kann der Stand gespeichert werden.</p>
            <div className="settingsActions">
              <button type="button" className="settingsButton ghost" onClick={cancelStopSession}>
                Nein
              </button>
              <button type="button" className="settingsButton" onClick={() => confirmStopSession(false)}>
                Ja, ohne Speichern
              </button>
              <button type="button" className="settingsButton stopConfirmButton" onClick={() => confirmStopSession(true)}>
                Ja + Speichern
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

export default App;
