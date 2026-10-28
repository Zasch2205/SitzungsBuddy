import {
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { availableMonitors, getCurrentWindow, primaryMonitor } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { save } from "@tauri-apps/plugin-dialog";
import { jsPDF } from "jspdf";
import readXlsxFile from "read-excel-file/browser";
import helpOverviewImage from "./assets/help-overview.png";
import logoOriginal from "./assets/sitzungsbuddy-logo-original.png";
import {
  hasSameAgendaBlueprint,
  isPlayableAgendaItem,
  normalizeOrder,
  sanitizeImportedText,
  type AgendaItem,
  type AgendaKind,
  type AgendaState,
} from "./lib/agenda";
import { fnv1aHash } from "./lib/checksum";
import { buildImportedAgenda, readCellText, readLabeledValue } from "./lib/excelImport";
import "./App.css";

type AsRunEntry = {
  id: string;
  topLabel: string;
  startedAtMs: number;
  startedAtLabel: string;
  varianceSec: number;
  plannedLabel: string;
  actualLabel: string;
  varianceLabel: string;
  isLive: boolean;
};

type AsRunFilter = "completed" | "all";
type DropPosition = "before" | "after";
type AgendaContextMenu = { itemId: string; x: number; y: number };
type MoveSelection = { anchorId: string; itemIds: string[] };
type LanViewRow = {
  kind: AgendaKind;
  state: AgendaState;
  stateLabel: string;
  order: number;
  top: string;
  title: string;
  scheduledStart: string;
  duration: string;
  isCurrent: boolean;
  isNext: boolean;
};

type LanViewSnapshot = {
  meetingTitle: string;
  meetingSubtitle: string;
  meetingDate: string;
  meetingLocation: string;
  onAir: boolean;
  isPaused: boolean;
  currentClock: string;
  sessionElapsed: string;
  prognosis: string;
  prognosisTone: "green" | "red" | "neutral";
  currentTop: string;
  topElapsed: string;
  countdown: string;
  countdownTone: "green" | "red" | "neutral";
  sessionStart: string;
  sessionEnd: string;
  nextBreak: string;
  hasRealAgenda: boolean;
  rows: LanViewRow[];
};

const audienceViewQueryParam = "view";
const audienceViewQueryValue = "audience";
const audienceWindowLabel = "audience-view";
const liveMirrorStorageKey = "sitzungsbuddy.live-mirror.v1";

function createDefaultAgenda(): AgendaItem[] {
  const placeholderRows = [
    "noch keine Agenda geladen",
    "Bitte Agenda über den Import Knopf importieren",
    "",
    "",
    "",
    "",
  ];

  return placeholderRows.map((title, index) => ({
    id: `placeholder-${index + 1}`,
    kind: "placeholder",
    day: "",
    order: index + 1,
    top: "",
    title,
    plannedDurationSec: 0,
    state: "planned",
    actualStartedAtMs: null,
    actualEndedAtMs: null,
    actualPausedMsTotal: 0,
  }));
}

const initialAgenda: AgendaItem[] = createDefaultAgenda();

const movableStates: AgendaState[] = ["planned", "hold"];
const defaultMeetingTitle = "";
const defaultMeetingSubtitle = "";
const defaultMeetingDateLabel = "";
const defaultMeetingLocation = "";
const maxImportFileSizeBytes = 5 * 1024 * 1024;
const maxImportSheetCount = 5;
const maxImportCellCount = 20_000;
const savedSessionStorageKey = "sitzungsbuddy.saved-session.v1";
const savedSessionSchemaVersion = 1;

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

type PersistedSessionEnvelope = {
  schemaVersion: number;
  checksum: string;
  payload: PersistedSession;
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

    const kind: AgendaKind =
      rawItem.kind === "break" || rawItem.kind === "heading" || rawItem.kind === "placeholder"
        ? rawItem.kind
        : "topic";
    const state: AgendaState =
      rawItem.state === "live" ||
      rawItem.state === "hold" ||
      rawItem.state === "done" ||
      rawItem.state === "skipped" ||
      rawItem.state === "planned"
        ? rawItem.state
        : "planned";

    const dayFallback = kind === "placeholder" ? "" : "Tag 1";
    const day = sanitizeImportedText(String(rawItem.day ?? dayFallback), 64) || dayFallback;
    const topFallback = kind === "break" ? "PAUSE" : kind === "placeholder" || kind === "heading" ? "" : String(index + 1);
    const top = sanitizeImportedText(String(rawItem.top ?? topFallback), 64) || topFallback;
    const titleFallback = kind === "break" ? "Pause" : kind === "heading" ? "Überschrift" : kind === "placeholder" ? "" : `TOP ${top}`;
    const title = sanitizeImportedText(String(rawItem.title ?? titleFallback), 200) || titleFallback;

    const durationFallback = kind === "placeholder" || kind === "heading" ? 0 : 300;
    const durationSec = Math.round(readNonNegativeNumber(rawItem.plannedDurationSec, durationFallback));
    const plannedDurationSec = kind === "placeholder" || kind === "heading" ? 0 : Math.max(60, durationSec);

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

function normalizePersistedSession(rawRecord: Record<string, unknown>): PersistedSession | null {
  const agenda = parseSavedAgenda(rawRecord.agenda);
  if (!agenda) {
    return null;
  }

  const parsedCurrentItemId =
    typeof rawRecord.currentItemId === "string" && agenda.some((item) => item.id === rawRecord.currentItemId)
      ? rawRecord.currentItemId
      : null;

  const onAir = Boolean(rawRecord.onAir) && parsedCurrentItemId !== null;
  const isPaused = onAir ? Boolean(rawRecord.isPaused) : false;
  const pauseStartedAtMs = isPaused ? readNullableNumber(rawRecord.pauseStartedAtMs) : null;

  return {
    savedAtMs: readNullableNumber(rawRecord.savedAtMs) ?? Date.now(),
    agenda,
    onAir,
    isPaused,
    pauseStartedAtMs,
    sessionPausedMsTotal: readNonNegativeNumber(rawRecord.sessionPausedMsTotal, 0),
    currentItemPausedMsTotal: readNonNegativeNumber(rawRecord.currentItemPausedMsTotal, 0),
    sessionStoppedAtMs: readNullableNumber(rawRecord.sessionStoppedAtMs),
    currentItemStoppedAtMs: readNullableNumber(rawRecord.currentItemStoppedAtMs),
    sessionStartedAt: readNullableNumber(rawRecord.sessionStartedAt),
    currentItemId: parsedCurrentItemId,
    currentItemStartedAt: parsedCurrentItemId ? readNullableNumber(rawRecord.currentItemStartedAt) : null,
    meetingTitle: sanitizeImportedText(String(rawRecord.meetingTitle ?? defaultMeetingTitle), 120) || defaultMeetingTitle,
    meetingSubtitle: sanitizeImportedText(String(rawRecord.meetingSubtitle ?? defaultMeetingSubtitle), 160),
    meetingDate: sanitizeImportedText(String(rawRecord.meetingDate ?? defaultMeetingDateLabel), 80),
    meetingLocation: sanitizeImportedText(String(rawRecord.meetingLocation ?? defaultMeetingLocation), 120),
  };
}

function buildPersistedSessionEnvelope(payload: PersistedSession): PersistedSessionEnvelope {
  // Die Prüfsumme erkennt beschädigte lokale Snapshots; sie ist keine kryptografische Signatur.
  const payloadJson = JSON.stringify(payload);

  return {
    schemaVersion: savedSessionSchemaVersion,
    checksum: fnv1aHash(payloadJson),
    payload,
  };
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

    const maybeEnvelope = parsedRaw as Record<string, unknown>;
    if (isRecord(maybeEnvelope.payload)) {
      const schemaVersion = readNonNegativeNumber(maybeEnvelope.schemaVersion, -1);
      const checksum = typeof maybeEnvelope.checksum === "string" ? maybeEnvelope.checksum : "";
      if (schemaVersion !== savedSessionSchemaVersion || !checksum) {
        return null;
      }

      const payloadJson = JSON.stringify(maybeEnvelope.payload);
      if (fnv1aHash(payloadJson) !== checksum) {
        return null;
      }

      return normalizePersistedSession(maybeEnvelope.payload);
    }

    return normalizePersistedSession(maybeEnvelope);
  } catch {
    return null;
  }
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

function parseSessionStartClock(value: string, originalTimestampMs: number): number | null {
  const match = value.trim().match(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);
  const updatedDate = new Date(originalTimestampMs);
  updatedDate.setHours(hours, minutes, seconds, 0);

  if (updatedDate.getHours() !== hours || updatedDate.getMinutes() !== minutes || updatedDate.getSeconds() !== seconds) {
    return null;
  }

  return updatedDate.getTime();
}

function formatSignedDuration(seconds: number): string {
  if (seconds === 0) {
    return "± 00:00";
  }

  const prefix = seconds > 0 ? "+" : "-";
  return `${prefix} ${formatCompact(Math.abs(seconds))}`;
}

function formatAgendaItemLabel(item: AgendaItem, style: "list" | "header" = "list"): string {
  if (item.kind === "break") {
    return item.title || "Pause";
  }

  if (item.kind === "placeholder" || item.kind === "heading") {
    return item.title;
  }

  const topText = item.top.trim();
  const titleText = item.title.trim();
  if (topText && titleText) {
    return `${topText}${style === "header" ? ". " : " "}${titleText}`;
  }

  return topText || titleText || "Ohne Titel";
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

function shownAgendaDurationSec(item: AgendaItem): number {
  if (item.state === "done" && item.actualStartedAtMs !== null && item.actualEndedAtMs !== null) {
    return Math.max(0, Math.floor((item.actualEndedAtMs - item.actualStartedAtMs - item.actualPausedMsTotal) / 1000));
  }

  return item.state === "skipped" ? 0 : item.plannedDurationSec;
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
  const agendaScrollAreaRef = useRef<HTMLElement | null>(null);
  const audienceWindowOpenedRef = useRef(false);
  const draggedItemIdRef = useRef<string | null>(null);
  const dragOverTargetRef = useRef<{ itemId: string; position: DropPosition } | null>(null);
  const mouseDragActiveRef = useRef(false);
  const appVersion = __APP_VERSION__;
  const isTauriRuntime = "__TAURI_INTERNALS__" in window;
  const isWindowsPlatform = useMemo(
    () => isTauriRuntime && window.navigator.userAgent.toLowerCase().includes("windows"),
    [isTauriRuntime],
  );
  const isAudienceView = useMemo(() => {
    const query = new URLSearchParams(window.location.search);
    return query.get(audienceViewQueryParam) === audienceViewQueryValue;
  }, []);
  const isExternalView = isAudienceView;

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

  const [meetingTitle, setMeetingTitle] = useState(defaultMeetingTitle);
  const [meetingSubtitle, setMeetingSubtitle] = useState(defaultMeetingSubtitle);
  const [meetingDate, setMeetingDate] = useState(defaultMeetingDateLabel);
  const [meetingLocation, setMeetingLocation] = useState(defaultMeetingLocation);
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
  const [editingSessionStart, setEditingSessionStart] = useState(false);
  const [editingSessionStartValue, setEditingSessionStartValue] = useState("");
  const [savedSessionCandidate, setSavedSessionCandidate] = useState<PersistedSession | null>(null);
  const [moveSelection, setMoveSelection] = useState<MoveSelection | null>(null);
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<{ itemId: string; position: DropPosition } | null>(null);
  const [agendaContextMenu, setAgendaContextMenu] = useState<AgendaContextMenu | null>(null);
  const [lanShareUrl, setLanShareUrl] = useState<string | null>(null);
  const [lanShareBusy, setLanShareBusy] = useState(false);
  const [lanShareMessage, setLanShareMessage] = useState("");

  const hasRealAgendaItems = useMemo(
    () => agenda.some(isPlayableAgendaItem),
    [agenda],
  );

  const currentIndex = useMemo(
    () => agenda.findIndex((item) => item.id === currentItemId),
    [agenda, currentItemId],
  );

  const currentItem = currentIndex >= 0 ? agenda[currentIndex] : null;
  const firstFutureIndex = currentIndex < 0 ? 0 : currentIndex + 1;

  const movingItemIds = useMemo(() => new Set(moveSelection?.itemIds ?? []), [moveSelection]);
  const movingBlock = useMemo(() => {
    if (!moveSelection || moveSelection.itemIds.length === 0) {
      return null;
    }

    const startIndex = agenda.findIndex((item) => movingItemIds.has(item.id));
    const endIndex = startIndex + moveSelection.itemIds.length - 1;
    if (startIndex < firstFutureIndex || endIndex >= agenda.length) {
      return null;
    }

    for (let index = startIndex; index <= endIndex; index += 1) {
      const item = agenda[index];
      if (!movingItemIds.has(item.id) || item.kind === "placeholder" || !movableStates.includes(item.state)) {
        return null;
      }
    }

    return { startIndex, endIndex };
  }, [agenda, firstFutureIndex, moveSelection, movingItemIds]);

  const canMoveSelectedItemUp =
    movingBlock !== null &&
    movingBlock.startIndex > firstFutureIndex &&
    agenda[movingBlock.startIndex - 1]?.kind !== "placeholder" &&
    movableStates.includes(agenda[movingBlock.startIndex - 1]?.state ?? "done");

  const canMoveSelectedItemDown =
    movingBlock !== null &&
    movingBlock.endIndex < agenda.length - 1 &&
    agenda[movingBlock.endIndex + 1]?.kind !== "placeholder" &&
    movableStates.includes(agenda[movingBlock.endIndex + 1]?.state ?? "done");

  const nextItemId = useMemo(() => {
    const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
    const nextPlanned = agenda.find(
      (item, index) => index >= startIndex && isPlayableAgendaItem(item) && item.state === "planned",
    );
    return nextPlanned?.id ?? null;
  }, [agenda, currentIndex]);

  const totalElapsedMs = useMemo(() => {
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
    return Math.max(0, elapsedMs);
  }, [isPaused, nowMs, onAir, pauseStartedAtMs, sessionPausedMsTotal, sessionStartedAt, sessionStoppedAtMs]);

  const totalElapsedSec = useMemo(() => Math.floor(totalElapsedMs / 1000), [totalElapsedMs]);

  const currentElapsedMs = useMemo(() => {
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
    return Math.max(0, elapsedMs);
  }, [
    currentItemPausedMsTotal,
    currentItemStartedAt,
    currentItemStoppedAtMs,
    isPaused,
    nowMs,
    onAir,
    pauseStartedAtMs,
  ]);

  const currentElapsedSec = useMemo(() => Math.floor(currentElapsedMs / 1000), [currentElapsedMs]);

  const remainingSec = currentItem ? currentItem.plannedDurationSec - currentElapsedSec : 0;

  const plannedElapsedMs = useMemo(() => {
    return agenda.reduce((sum, item) => {
      if (item.state === "done") {
        return sum + item.plannedDurationSec * 1000;
      }

      if (item.state === "live" && item.id === currentItemId) {
        return sum + Math.min(currentElapsedMs, item.plannedDurationSec * 1000);
      }

      return sum;
    }, 0);
  }, [agenda, currentElapsedMs, currentItemId]);

  const prognosisSec = useMemo(
    () => Math.trunc((totalElapsedMs - plannedElapsedMs) / 1000),
    [plannedElapsedMs, totalElapsedMs],
  );

  const asRunEntries = useMemo<AsRunEntry[]>(() => {
    return agenda
      .filter((item) => isPlayableAgendaItem(item) && item.actualStartedAtMs !== null)
      .map((item) => {
        const startedAtMs = item.actualStartedAtMs ?? nowMs;
        const finishedAtMs = item.actualEndedAtMs ?? (item.id === currentItemId ? nowMs : startedAtMs);
        const livePauseDeltaMs =
          item.state === "live" && isPaused && pauseStartedAtMs !== null ? nowMs - pauseStartedAtMs : 0;
        const actualMs = finishedAtMs - startedAtMs - item.actualPausedMsTotal - livePauseDeltaMs;
        const actualSec = Math.max(0, Math.floor(actualMs / 1000));
        const plannedSec = item.plannedDurationSec;
        const varianceSec = actualSec - plannedSec;

        return {
          id: item.id,
          topLabel: formatAgendaItemLabel(item, "list"),
          startedAtMs,
          startedAtLabel: formatTimeOfDay(startedAtMs),
          varianceSec,
          plannedLabel: formatClock(plannedSec),
          actualLabel: formatClock(actualSec),
          varianceLabel: formatSignedDuration(varianceSec),
          isLive: item.state === "live",
        };
      })
      .sort((left, right) => left.startedAtMs - right.startedAtMs);
  }, [agenda, currentItemId, isPaused, nowMs, pauseStartedAtMs]);

  // Abgeschlossene Punkte zählen mit Ist-Dauer, offene mit Plan-Dauer. Die Live-Uhr darf
  // künftige Startzeiten nicht sekündlich verschieben; erst ein Trigger setzt sie neu.
  const scheduleTiming = useMemo(() => {
    const startTimeByItemId = new Map<string, string>();

    if (sessionStartedAt === null) {
      for (const item of agenda) {
        startTimeByItemId.set(item.id, "--:--:--");
      }

      return {
        startTimeByItemId,
        sessionEndLabel: "--:--:--",
      };
    }

    let elapsedBeforeItemSec = 0;

    for (const item of agenda) {
      startTimeByItemId.set(item.id, formatTimeOfDay(sessionStartedAt + elapsedBeforeItemSec * 1000));

      let durationSec = item.plannedDurationSec;

      if (item.state === "done" && item.actualStartedAtMs !== null && item.actualEndedAtMs !== null) {
        const actualMs = item.actualEndedAtMs - item.actualStartedAtMs - item.actualPausedMsTotal;
        durationSec = Math.max(0, Math.floor(actualMs / 1000));
      } else if (item.state === "skipped") {
        durationSec = 0;
      }

      elapsedBeforeItemSec += durationSec;
    }

    return {
      startTimeByItemId,
      sessionEndLabel: formatTimeOfDay(sessionStartedAt + elapsedBeforeItemSec * 1000),
    };
  }, [agenda, sessionStartedAt]);

  const nextPlannedBreakLabel = useMemo(() => {
    const nextBreak = agenda.find((item, index) => {
      if (item.kind !== "break") {
        return false;
      }

      if (item.state === "done" || item.state === "skipped") {
        return false;
      }

      return index > currentIndex;
    });

    if (!nextBreak) {
      return "--:--:--";
    }

    return scheduleTiming.startTimeByItemId.get(nextBreak.id) ?? "--:--:--";
  }, [agenda, currentIndex, scheduleTiming.startTimeByItemId]);

  const filteredAsRunEntries = useMemo(() => {
    if (asRunFilter === "completed") {
      return asRunEntries.filter((entry) => !entry.isLive);
    }

    return asRunEntries;
  }, [asRunEntries, asRunFilter]);

  const applySessionSnapshot = useCallback((snapshot: PersistedSession) => {
    setAgenda(normalizeOrder(snapshot.agenda));
    setOnAir(snapshot.onAir);
    setIsPaused(snapshot.isPaused);
    setPauseStartedAtMs(snapshot.pauseStartedAtMs);
    setSessionPausedMsTotal(snapshot.sessionPausedMsTotal);
    setCurrentItemPausedMsTotal(snapshot.currentItemPausedMsTotal);
    setSessionStoppedAtMs(snapshot.sessionStoppedAtMs);
    setCurrentItemStoppedAtMs(snapshot.currentItemStoppedAtMs);
    setSessionStartedAt(snapshot.sessionStartedAt);
    setEditingSessionStart(false);
    setEditingSessionStartValue("");
    setCurrentItemId(snapshot.currentItemId);
    setCurrentItemStartedAt(snapshot.currentItemStartedAt);
    setMeetingTitle(snapshot.meetingTitle);
    setMeetingSubtitle(snapshot.meetingSubtitle);
    setMeetingDate(snapshot.meetingDate);
    setMeetingLocation(snapshot.meetingLocation);
    setSettingsTitleDraft(snapshot.meetingTitle);
    setSettingsDateDraft(snapshot.meetingDate);
    setSettingsLocationDraft(snapshot.meetingLocation);
    setNowMs(Date.now());
  }, []);

  // Das Operator-Fenster ist die einzige schreibende Quelle; die Beameransicht liest Snapshots.
  useEffect(() => {
    if (isExternalView) {
      return;
    }

    try {
      const envelope = buildPersistedSessionEnvelope({
        savedAtMs: Date.now(),
        agenda,
        onAir,
        isPaused,
        pauseStartedAtMs,
        sessionPausedMsTotal,
        currentItemPausedMsTotal,
        sessionStoppedAtMs,
        currentItemStoppedAtMs,
        sessionStartedAt,
        currentItemId,
        currentItemStartedAt,
        meetingTitle,
        meetingSubtitle,
        meetingDate,
        meetingLocation,
      });

      window.localStorage.setItem(liveMirrorStorageKey, JSON.stringify(envelope));
    } catch {
      // ignore storage errors
    }
  }, [
    agenda,
    currentItemId,
    currentItemPausedMsTotal,
    currentItemStartedAt,
    currentItemStoppedAtMs,
    isExternalView,
    isPaused,
    meetingDate,
    meetingLocation,
    meetingSubtitle,
    meetingTitle,
    onAir,
    pauseStartedAtMs,
    sessionPausedMsTotal,
    sessionStartedAt,
    sessionStoppedAtMs,
  ]);

  useEffect(() => {
    if (!isExternalView) {
      return;
    }

    const applyLiveMirrorSnapshot = (rawValue: string | null) => {
      const parsed = parseSavedSession(rawValue);
      if (!parsed) {
        return;
      }

      applySessionSnapshot(parsed);
    };

    let active = true;
    const hydrateFromStorage = () => {
      if (!active) {
        return;
      }

      try {
        applyLiveMirrorSnapshot(window.localStorage.getItem(liveMirrorStorageKey));
      } catch {
        // ignore storage errors
      }
    };

    hydrateFromStorage();

    const mirrorPolling = window.setInterval(hydrateFromStorage, 1000);
    const handleStorage = (event: StorageEvent) => {
      if (event.key === liveMirrorStorageKey) {
        applyLiveMirrorSnapshot(event.newValue);
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => {
      active = false;
      window.clearInterval(mirrorPolling);
      window.removeEventListener("storage", handleStorage);
    };
  }, [applySessionSnapshot, isExternalView]);

  useEffect(() => {
    if (isExternalView || !isTauriRuntime) {
      return;
    }

    let active = true;

    const ensureBeamerWindow = async () => {
      if (!active) {
        return;
      }

      try {
        const monitors = await availableMonitors();
        if (!active || monitors.length < 2) {
          audienceWindowOpenedRef.current = false;
          return;
        }

        const existingWindow = await WebviewWindow.getByLabel(audienceWindowLabel);
        if (!active) {
          return;
        }

        if (existingWindow) {
          audienceWindowOpenedRef.current = true;
          return;
        }

        if (audienceWindowOpenedRef.current) {
          return;
        }

        const primary = await primaryMonitor();
        const externalMonitor =
          monitors.find((monitor) => {
            if (!primary) {
              return true;
            }

            return monitor.position.x !== primary.position.x || monitor.position.y !== primary.position.y;
          }) ?? monitors[1];

        if (!externalMonitor) {
          return;
        }

        const workPosition = externalMonitor.workArea.position.toLogical(externalMonitor.scaleFactor);
        const workSize = externalMonitor.workArea.size.toLogical(externalMonitor.scaleFactor);

        const beamerWindow = new WebviewWindow(audienceWindowLabel, {
          title: "Sitzungsbuddy · Beamer",
          url: `/?${audienceViewQueryParam}=${audienceViewQueryValue}`,
          x: Math.round(workPosition.x),
          y: Math.round(workPosition.y),
          width: Math.max(960, Math.round(workSize.width)),
          height: Math.max(700, Math.round(workSize.height)),
          decorations: false,
          resizable: true,
        });

        beamerWindow.once("tauri://created", async () => {
          audienceWindowOpenedRef.current = true;

          if (isWindowsPlatform) {
            await beamerWindow.setPosition(externalMonitor.position).catch((error) => {
              console.warn("Beamer-Fenster konnte nicht auf dem externen Monitor positioniert werden.", error);
            });
          }

          try {
            await beamerWindow.setFullscreen(true);
          } catch (error) {
            console.warn("Beamer-Vollbild konnte nicht aktiviert werden.", error);
            if (isWindowsPlatform) {
              await beamerWindow.maximize().catch((maximizeError) => {
                console.warn("Beamer-Fenster konnte nicht maximiert werden.", maximizeError);
              });
            }
          }
        });
      } catch (error) {
        console.warn("Beamer-Fenster konnte nicht erstellt werden.", error);
      }
    };

    void ensureBeamerWindow();
    const monitorPolling = window.setInterval(() => {
      void ensureBeamerWindow();
    }, 5000);

    return () => {
      active = false;
      window.clearInterval(monitorPolling);
    };
  }, [isExternalView, isTauriRuntime, isWindowsPlatform]);

  const clearSavedSession = useCallback(() => {
    try {
      window.localStorage.removeItem(savedSessionStorageKey);
    } catch {
      // ignore storage errors
    }
  }, []);

  const persistSessionSnapshot = useCallback((snapshot: PersistedSession): boolean => {
    try {
      const envelope = buildPersistedSessionEnvelope(snapshot);
      window.localStorage.setItem(savedSessionStorageKey, JSON.stringify(envelope));
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

    applySessionSnapshot(savedSessionCandidate);
    setImportInfo(`Gespeicherter Stand vom ${new Date(savedSessionCandidate.savedAtMs).toLocaleString("de-DE")} geladen.`);
    setSavedSessionCandidate(null);
    clearSavedSession();
  }, [applySessionSnapshot, clearSavedSession, savedSessionCandidate]);

  const dismissSavedSession = useCallback(() => {
    clearSavedSession();
    setSavedSessionCandidate(null);
  }, [clearSavedSession]);

  useEffect(() => {
    if (isExternalView) {
      return;
    }

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
      setImportInfo("Gespeicherter Sitzungsstand war ungültig und wurde aus Sicherheitsgründen verworfen.");
      return;
    }

    setSavedSessionCandidate(parsed);
  }, [clearSavedSession, isExternalView]);

  useEffect(() => {
    if (!isExternalView || !currentItemId) {
      return;
    }

    let rafA = 0;
    let rafB = 0;

    const alignLiveRow = () => {
      const scrollContainer = agendaScrollAreaRef.current;
      if (!scrollContainer) {
        return;
      }

      const agendaRows = Array.from(scrollContainer.querySelectorAll<HTMLElement>("li[data-item-id]"));
      if (agendaRows.length === 0) {
        return;
      }

      const liveIndex = agendaRows.findIndex((row) => row.dataset.itemId === currentItemId);
      if (liveIndex < 0) {
        return;
      }

      const anchorIndex = Math.max(0, liveIndex - 1);
      const anchorRow = agendaRows[anchorIndex];
      if (!anchorRow) {
        return;
      }

      anchorRow.scrollIntoView({
        block: "start",
        behavior: "auto",
      });
    };

    rafA = window.requestAnimationFrame(() => {
      rafB = window.requestAnimationFrame(alignLiveRow);
    });

    return () => {
      window.cancelAnimationFrame(rafA);
      window.cancelAnimationFrame(rafB);
    };
  }, [agenda.length, currentItemId, isExternalView]);

  useEffect(() => {
    if (isExternalView || !isTauriRuntime) {
      return;
    }

    void invoke("set_on_air_mode", { enabled: onAir }).catch((error) => {
      console.warn("Sleep-Blocker konnte nicht gesetzt werden.", error);
    });

    return () => {
      void invoke("set_on_air_mode", { enabled: false }).catch(() => {
        // ignore cleanup failures
      });
    };
  }, [isExternalView, isTauriRuntime, onAir]);

  const advanceToNextItem = useCallback(() => {
    if (isExternalView || !onAir || isPaused) {
      return;
    }

    const timestamp = Date.now();
    const currentIndexInAgenda = currentItemId
      ? agenda.findIndex((item) => item.id === currentItemId)
      : -1;
    const nextIndex = agenda.findIndex(
      (item, index) => index > currentIndexInAgenda && isPlayableAgendaItem(item) && item.state === "planned",
    );

    const nextItemId = nextIndex >= 0 ? agenda[nextIndex].id : null;

    const updated = agenda.map((item, index) => {
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

      if (
        item.kind === "heading" &&
        item.state === "planned" &&
        index > currentIndexInAgenda &&
        (nextIndex < 0 || index < nextIndex)
      ) {
        // Überschriften sind sichtbar, verbrauchen aber weder Sendezeit noch einen Trigger.
        return { ...item, state: "done" as const };
      }

      return item;
    });

    setAgenda(updated);
    setCurrentItemId(nextItemId);
    setCurrentItemStartedAt(nextItemId ? timestamp : null);
    setCurrentItemPausedMsTotal(0);
    setCurrentItemStoppedAtMs(nextItemId ? null : timestamp);
    setNowMs(timestamp);
  }, [agenda, currentItemId, isExternalView, isPaused, onAir]);

  const rewindToPreviousItem = useCallback(() => {
    if (isExternalView || !onAir || isPaused) {
      return;
    }

    const timestamp = Date.now();
    const currentIndexInAgenda = currentItemId
      ? agenda.findIndex((item) => item.id === currentItemId)
      : agenda.length;

    let previousDoneIndex = -1;
    for (let index = currentIndexInAgenda - 1; index >= 0; index -= 1) {
      if (isPlayableAgendaItem(agenda[index]) && agenda[index].state === "done") {
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

      if (item.kind === "heading" && item.state === "done" && index > previousDoneIndex && index < currentIndexInAgenda) {
        // Beim Zurücktriggern werden übergangene Überschriften für den nächsten Vorlauf wieder offen.
        return { ...item, state: "planned" as const };
      }

      return item;
    });

    setAgenda(updated);
    setCurrentItemId(previousItem.id);
    setCurrentItemStartedAt(previousItem.actualStartedAtMs ?? timestamp);
    setCurrentItemPausedMsTotal(previousItem.actualPausedMsTotal);
    setCurrentItemStoppedAtMs(null);
    setNowMs(timestamp);
  }, [agenda, currentItemId, isExternalView, isPaused, onAir]);

  const handleOnAirClick = useCallback(() => {
    if (isExternalView) {
      return;
    }

    if (onAir) {
      setIsStopConfirmOpen(true);
      return;
    }

    if (!hasRealAgendaItems) {
      setImportInfo("Bitte zuerst eine Agenda importieren.");
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

    const firstPlannedIndex = agenda.findIndex((item) => isPlayableAgendaItem(item) && item.state === "planned");
    const firstPlanned = agenda[firstPlannedIndex];
    if (!firstPlanned) {
      return;
    }

    setAgenda((previous) =>
      previous.map((item, index) => {
        if (item.kind === "heading" && item.state === "planned" && index < firstPlannedIndex) {
          return { ...item, state: "done" as const };
        }

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
  }, [agenda, currentItemId, hasRealAgendaItems, isExternalView, onAir, sessionStartedAt]);

  const togglePauseSession = useCallback(() => {
    if (isExternalView || !onAir) {
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
  }, [currentItemId, isExternalView, isPaused, onAir, pauseStartedAtMs]);

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

  const minimizeWindow = useCallback(() => {
    if (!isTauriRuntime) {
      return;
    }

    const currentWindow = getCurrentWindow();
    void (async () => {
      if (await currentWindow.isFullscreen()) {
        await currentWindow.setFullscreen(false);
      }
      await currentWindow.minimize();
    })().catch((error) => {
      console.warn("Fenster konnte nicht minimiert werden.", error);
    });
  }, [isTauriRuntime]);

  const toggleMaximizeWindow = useCallback(() => {
    if (!isTauriRuntime) {
      return;
    }

    const currentWindow = getCurrentWindow();
    void (async () => {
      if (await currentWindow.isFullscreen()) {
        await currentWindow.setFullscreen(false);
        await currentWindow.maximize();
      } else if (await currentWindow.isMaximized()) {
        await currentWindow.unmaximize();
      } else {
        await currentWindow.maximize();
      }
    })().catch((error) => {
      console.warn("Fenster konnte nicht maximiert oder wiederhergestellt werden.", error);
    });
  }, [isTauriRuntime]);

  const closeWindow = useCallback(() => {
    if (!isTauriRuntime) {
      return;
    }

    void getCurrentWindow().close().catch((error) => {
      console.warn("Fenster konnte nicht geschlossen werden.", error);
    });
  }, [isTauriRuntime]);

  const hasSessionRuntimeData = useMemo(() => {
    if (onAir || isPaused || sessionStartedAt !== null || currentItemId !== null) {
      return true;
    }

    return agenda.some(
      (item) =>
        item.state !== "planned" ||
        item.actualStartedAtMs !== null ||
        item.actualEndedAtMs !== null ||
        item.actualPausedMsTotal > 0,
    );
  }, [agenda, currentItemId, isPaused, onAir, sessionStartedAt]);

  const hasCustomizedAgendaSetup = useMemo(() => {
    if (!hasSameAgendaBlueprint(agenda, initialAgenda)) {
      return true;
    }

    return (
      meetingTitle !== defaultMeetingTitle ||
      meetingSubtitle !== defaultMeetingSubtitle ||
      meetingDate !== defaultMeetingDateLabel ||
      meetingLocation !== defaultMeetingLocation
    );
  }, [agenda, meetingDate, meetingLocation, meetingSubtitle, meetingTitle]);

  const resetAgendaForImport = useCallback(() => {
    const resetTimestamp = Date.now();

    setAgenda(initialAgenda);
    setMeetingTitle(defaultMeetingTitle);
    setMeetingSubtitle(defaultMeetingSubtitle);
    setMeetingDate(defaultMeetingDateLabel);
    setMeetingLocation(defaultMeetingLocation);
    setOnAir(false);
    setIsPaused(false);
    setPauseStartedAtMs(null);
    setSessionPausedMsTotal(0);
    setCurrentItemPausedMsTotal(0);
    setSessionStartedAt(null);
    setEditingSessionStart(false);
    setEditingSessionStartValue("");
    setSessionStoppedAtMs(null);
    setCurrentItemId(null);
    setCurrentItemStartedAt(null);
    setCurrentItemStoppedAtMs(null);
    setEditingDurationItemId(null);
    setEditingDurationValue("");
    setEditingTitleItemId(null);
    setEditingTitleValue("");
    setAsRunFilter("all");
    setMoveSelection(null);
    setDraggedItemId(null);
    draggedItemIdRef.current = null;
    dragOverTargetRef.current = null;
    mouseDragActiveRef.current = false;
    setDragOverTarget(null);
    setNowMs(resetTimestamp);
    clearSavedSession();
    setSavedSessionCandidate(null);
  }, [clearSavedSession]);

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

      if (hasSessionRuntimeData) {
        const shouldOverwriteRuntimeData = window.confirm(
          "Es liegen bereits laufende oder gesendete Sitzungsdaten vor. Soll der Import diese Daten wirklich überschreiben?",
        );

        if (!shouldOverwriteRuntimeData) {
          event.target.value = "";
          return;
        }
      } else if (hasCustomizedAgendaSetup || savedSessionCandidate !== null) {
        const shouldOverwritePlannedData = window.confirm(
          "Es liegen bereits konfigurierte Sitzungsdaten vor. Soll der Import diese Planung überschreiben?",
        );

        if (!shouldOverwritePlannedData) {
          event.target.value = "";
          return;
        }
      }

      try {
        const workbookSheets = await readXlsxFile(selectedFile);

        if (workbookSheets.length === 0 || workbookSheets.length > maxImportSheetCount) {
          throw new Error("Workbook hat ungültige Anzahl Tabellen.");
        }

        const firstSheet = workbookSheets[0];

        if (!firstSheet || !Array.isArray(firstSheet.data)) {
          throw new Error("Keine Tabelle in der Datei gefunden.");
        }

        const firstSheetData = firstSheet.data;

        const rowCount = firstSheetData.length;
        const colCount = firstSheetData.reduce((maxCols: number, row: Array<unknown>) => Math.max(maxCols, row.length), 0);
        if (rowCount * colCount > maxImportCellCount) {
          throw new Error("Tabelle ist zu groß.");
        }

        const importedAgenda = buildImportedAgenda(firstSheetData);
        if (importedAgenda.length === 0) {
          throw new Error(
            "Keine TOPs gefunden. Erwartet werden TOP in A, Titel in B, Dauer in C und Tag in D (ab Zeile 6).",
          );
        }

        const importedTitle = sanitizeImportedText(readCellText(firstSheetData, "A1"), 80) || defaultMeetingTitle;
        const importedSubtitle = sanitizeImportedText(readCellText(firstSheetData, "A4"), 160) || defaultMeetingSubtitle;
        const importedLocation =
          sanitizeImportedText(readCellText(firstSheetData, "B2"), 80) ||
          sanitizeImportedText(readLabeledValue(firstSheetData, /ort/i), 80) ||
          defaultMeetingLocation;
        const importedDate =
          sanitizeImportedText(readCellText(firstSheetData, "B3"), 80) ||
          sanitizeImportedText(readLabeledValue(firstSheetData, /datum/i), 80) ||
          sanitizeImportedText(readCellText(firstSheetData, "C2"), 80) ||
          defaultMeetingDateLabel;

        resetAgendaForImport();

        setAgenda(importedAgenda);
        setMeetingTitle(importedTitle);
        setMeetingSubtitle(importedSubtitle);
        setMeetingDate(importedDate);
        setMeetingLocation(importedLocation);

        setImportInfo(`Import erfolgreich (${importedAgenda.length} Agendaeinträge).`);
      } catch (error) {
        console.error("Agenda import failed", error);
        setImportInfo("Import fehlgeschlagen. Bitte Datei und Format prüfen (A=TOP, B=Titel, C=Dauer, D=Tag/P/U, optional E=Uhrzeit).");
      } finally {
        event.target.value = "";
      }
    },
    [
      hasCustomizedAgendaSetup,
      hasSessionRuntimeData,
      resetAgendaForImport,
      savedSessionCandidate,
    ],
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
    const columnStart = 258;
    const columnPlanned = 336;
    const columnActual = 412;
    const columnVariance = 486;
    let cursorY = 52;

    const drawTableHeader = (y: number) => {
      pdfDocument.setFont("helvetica", "bold");
      pdfDocument.setFontSize(11);
      pdfDocument.text("TOP", columnTop, y);
      pdfDocument.text("Start", columnStart, y);
      pdfDocument.text("Geplant", columnPlanned, y);
      pdfDocument.text("Ist", columnActual, y);
      pdfDocument.text("Abw.", columnVariance, y);
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
        entry.topLabel.length > 39 ? `${entry.topLabel.slice(0, 36).trimEnd()}…` : entry.topLabel;

      pdfDocument.text(topLabel, columnTop, cursorY);
      pdfDocument.text(entry.startedAtLabel, columnStart, cursorY);
      pdfDocument.text(entry.plannedLabel, columnPlanned, cursorY);
      pdfDocument.text(entry.actualLabel, columnActual, cursorY);
      pdfDocument.text(entry.varianceLabel, columnVariance, cursorY);

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

  const toggleMoveMode = useCallback(
    (itemId: string, withShift: boolean) => {
      const targetIndex = agenda.findIndex((item) => item.id === itemId);
      const targetItem = agenda[targetIndex];
      if (
        targetIndex < firstFutureIndex ||
        !targetItem ||
        targetItem.kind === "placeholder" ||
        !movableStates.includes(targetItem.state)
      ) {
        return;
      }

      setMoveSelection((previous) => {
        // Die erste Auswahl bleibt Anker; Umschalt-Klick erweitert sie zu einem lückenlosen Block.
        if (!withShift || !previous) {
          if (!withShift && previous?.itemIds.length === 1 && previous.itemIds[0] === itemId) {
            return null;
          }

          return { anchorId: itemId, itemIds: [itemId] };
        }

        const anchorIndex = agenda.findIndex((item) => item.id === previous.anchorId);
        const startIndex = Math.min(anchorIndex, targetIndex);
        const endIndex = Math.max(anchorIndex, targetIndex);
        if (startIndex < firstFutureIndex) {
          return previous;
        }

        const items = agenda.slice(startIndex, endIndex + 1);
        if (items.some((item) => item.kind === "placeholder" || !movableStates.includes(item.state))) {
          return previous;
        }

        return { anchorId: previous.anchorId, itemIds: items.map((item) => item.id) };
      });
    },
    [agenda, firstFutureIndex],
  );

  const moveSelectedItem = useCallback(
    (direction: -1 | 1) => {
      if (!moveSelection || !movingBlock) {
        return;
      }

      setAgenda((previous) => {
        const selectedIds = new Set(moveSelection.itemIds);
        const startIndex = previous.findIndex((item) => selectedIds.has(item.id));
        const endIndex = startIndex + selectedIds.size - 1;
        const currentIndexInPrevious = currentItemId
          ? previous.findIndex((item) => item.id === currentItemId)
          : -1;
        const targetIndex = direction < 0 ? startIndex - 1 : endIndex + 1;
        const targetItem = previous[targetIndex];

        if (
          startIndex <= currentIndexInPrevious ||
          endIndex >= previous.length ||
          targetIndex <= currentIndexInPrevious ||
          !targetItem ||
          targetItem.kind === "placeholder" ||
          !movableStates.includes(targetItem.state)
        ) {
          return previous;
        }

        for (let index = startIndex; index <= endIndex; index += 1) {
          const item = previous[index];
          if (!selectedIds.has(item.id) || item.kind === "placeholder" || !movableStates.includes(item.state)) {
            return previous;
          }
        }

        const reordered = [...previous];
        const [neighbor] = reordered.splice(targetIndex, 1);
        reordered.splice(direction < 0 ? endIndex : startIndex, 0, neighbor);
        return normalizeOrder(reordered);
      });
    },
    [currentItemId, moveSelection, movingBlock],
  );

  const moveFutureItemByDragDrop = useCallback(
    (itemId: string, targetItemId: string, position: DropPosition) => {
      setAgenda((previous) => {
        const sourceIndex = previous.findIndex((item) => item.id === itemId);
        const targetIndex = previous.findIndex((item) => item.id === targetItemId);

        if (sourceIndex < 0 || targetIndex < 0) {
          return previous;
        }

        const currentIndexInPrevious = currentItemId
          ? previous.findIndex((item) => item.id === currentItemId)
          : -1;
        const firstFutureIndex = currentIndexInPrevious + 1;

        if (sourceIndex < firstFutureIndex || targetIndex < firstFutureIndex) {
          return previous;
        }

        const sourceItem = previous[sourceIndex];
        const targetItem = previous[targetIndex];
        if (!sourceItem || !targetItem) {
          return previous;
        }

        if (!movableStates.includes(sourceItem.state) || !movableStates.includes(targetItem.state)) {
          return previous;
        }

        const reordered = [...previous];
        const [movedItem] = reordered.splice(sourceIndex, 1);
        if (!movedItem) {
          return previous;
        }

        let insertionIndex = targetIndex + (position === "after" ? 1 : 0);
        if (sourceIndex < insertionIndex) {
          insertionIndex -= 1;
        }

        const boundedInsertionIndex = Math.max(firstFutureIndex, Math.min(insertionIndex, reordered.length));
        if (boundedInsertionIndex === sourceIndex) {
          return previous;
        }

        reordered.splice(boundedInsertionIndex, 0, movedItem);
        return normalizeOrder(reordered);
      });
    },
    [currentItemId],
  );

  const beginMouseDrag = useCallback(
    (event: ReactMouseEvent<HTMLLIElement>, itemId: string, canDragItem: boolean) => {
      if (!canDragItem || event.button !== 0) {
        return;
      }

      const targetElement = event.target as HTMLElement | null;
      if (targetElement?.closest("button, input, textarea, select, .title.editable, .duration.editable, .titleInput, .durationInput")) {
        return;
      }

      event.preventDefault();
      mouseDragActiveRef.current = true;
      draggedItemIdRef.current = itemId;
      setDraggedItemId(itemId);
      setDragOverTarget(null);
    },
    [],
  );

  const resolveDropTargetFromPointer = useCallback(
    (clientY: number, sourceItemId: string): { itemId: string; position: DropPosition } | null => {
      const rows = Array.from(document.querySelectorAll<HTMLLIElement>("li[data-item-id]"));
      const sourceIndex = agenda.findIndex((item) => item.id === sourceItemId);
      const currentIndexInAgenda = currentItemId ? agenda.findIndex((item) => item.id === currentItemId) : -1;
      const firstFutureIndex = currentIndexInAgenda + 1;

      if (sourceIndex < firstFutureIndex) {
        return null;
      }

      const allowedRows = rows.filter((row) => {
        const itemId = row.dataset.itemId;
        if (!itemId || itemId === sourceItemId) {
          return false;
        }

        const index = agenda.findIndex((item) => item.id === itemId);
        if (index < firstFutureIndex) {
          return false;
        }

        const item = agenda[index];
        return item ? item.kind !== "placeholder" && movableStates.includes(item.state) : false;
      });

      if (allowedRows.length === 0) {
        return null;
      }

      for (const row of allowedRows) {
        const rect = row.getBoundingClientRect();
        const rowItemId = row.dataset.itemId;
        if (!rowItemId) {
          continue;
        }

        const midpoint = rect.top + rect.height / 2;
        if (clientY < midpoint) {
          return {
            itemId: rowItemId,
            position: "before",
          };
        }

        if (clientY <= rect.bottom) {
          return {
            itemId: rowItemId,
            position: "after",
          };
        }
      }

      const lastRow = allowedRows[allowedRows.length - 1];
      const lastRowItemId = lastRow?.dataset.itemId;
      if (!lastRowItemId) {
        return null;
      }

      return {
        itemId: lastRowItemId,
        position: "after",
      };
    },
    [agenda, currentItemId],
  );

  useEffect(() => {
    if (!moveSelection || movingBlock) {
      return;
    }

    setMoveSelection(null);
  }, [moveSelection, movingBlock]);

  useEffect(() => {
    dragOverTargetRef.current = dragOverTarget;
  }, [dragOverTarget]);

  useEffect(() => {
    setAgendaContextMenu(null);
  }, [agenda]);

  useEffect(() => {
    if (!agendaContextMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".agendaContextMenu")) {
        setAgendaContextMenu(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAgendaContextMenu(null);
      }
    };
    const closeMenu = () => setAgendaContextMenu(null);

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
    };
  }, [agendaContextMenu]);

  useEffect(() => {
    if (!draggedItemId || !mouseDragActiveRef.current) {
      return;
    }

    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const handleMouseMove = (event: MouseEvent) => {
      const sourceItemId = draggedItemIdRef.current ?? draggedItemId;
      if (!sourceItemId) {
        return;
      }

      const pointerTarget = resolveDropTargetFromPointer(event.clientY, sourceItemId);
      if (!pointerTarget) {
        setDragOverTarget(null);
        return;
      }

      setDragOverTarget((previous) => {
        if (previous?.itemId === pointerTarget.itemId && previous.position === pointerTarget.position) {
          return previous;
        }

        return pointerTarget;
      });
    };

    const handleMouseUp = () => {
      const sourceItemId = draggedItemIdRef.current ?? draggedItemId;
      const target = dragOverTargetRef.current;

      if (sourceItemId && target) {
        moveFutureItemByDragDrop(sourceItemId, target.itemId, target.position);
      }

      mouseDragActiveRef.current = false;
      draggedItemIdRef.current = null;
      dragOverTargetRef.current = null;
      setDraggedItemId(null);
      setDragOverTarget(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [draggedItemId, moveFutureItemByDragDrop, resolveDropTargetFromPointer]);

  const deleteFutureItem = useCallback((itemId: string) => {
    setAgendaContextMenu(null);
    setAgenda((previous) => {
      const itemIndex = previous.findIndex((item) => item.id === itemId);
      const currentIndexInPrevious = currentItemId
        ? previous.findIndex((item) => item.id === currentItemId)
        : -1;
      const item = previous[itemIndex];

      if (
        !item ||
        itemIndex <= currentIndexInPrevious ||
        item.kind === "placeholder" ||
        !movableStates.includes(item.state)
      ) {
        return previous;
      }

      return normalizeOrder(previous.filter((candidate) => candidate.id !== itemId));
    });
    setMoveSelection((previous) => previous?.itemIds.includes(itemId) ? null : previous);
    setEditingDurationItemId((previous) => previous === itemId ? null : previous);
    setEditingTitleItemId((previous) => previous === itemId ? null : previous);
  }, [currentItemId]);

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

  const insertBlankAfterNextItem = useCallback(() => {
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

      const blankItem: AgendaItem = {
        id: `blank-${timestamp}-${Math.floor(Math.random() * 10000)}`,
        kind: "topic",
        day: anchorItem?.day ?? "Tag 1",
        order: 0,
        top: "",
        title: "Neuer Eintrag",
        plannedDurationSec: 5 * 60,
        state: "planned",
        actualStartedAtMs: null,
        actualEndedAtMs: null,
        actualPausedMsTotal: 0,
      };

      const updated = [...previous.slice(0, insertAt), blankItem, ...previous.slice(insertAt)];
      return normalizeOrder(updated);
    });

    setImportInfo("Blanko-Zeile (05:00) wurde eingefügt.");
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

  const beginSessionStartEdit = useCallback(() => {
    if (isAudienceView || sessionStartedAt === null) {
      return;
    }

    setEditingSessionStartValue(formatTimeOfDay(sessionStartedAt));
    setEditingSessionStart(true);
  }, [isAudienceView, sessionStartedAt]);

  const cancelSessionStartEdit = useCallback(() => {
    setEditingSessionStart(false);
    setEditingSessionStartValue("");
  }, []);

  const commitSessionStartEdit = useCallback(() => {
    if (!editingSessionStart || sessionStartedAt === null) {
      return;
    }

    const draft = editingSessionStartValue.trim();
    if (draft === formatTimeOfDay(sessionStartedAt)) {
      cancelSessionStartEdit();
      return;
    }

    const updatedTimestamp = parseSessionStartClock(draft, sessionStartedAt);
    if (updatedTimestamp === null) {
      cancelSessionStartEdit();
      window.alert("Diese Anfangsuhrzeit ist nicht erlaubt. Bitte HH:MM oder HH:MM:SS eingeben.");
      return;
    }

    if (updatedTimestamp > Date.now()) {
      cancelSessionStartEdit();
      window.alert("Diese Anfangsuhrzeit ist nicht erlaubt: Sie liegt in der Zukunft.");
      return;
    }

    const sessionReferenceMs = resolveTimerReferenceMs({
      onAir,
      isPaused,
      pauseStartedAtMs,
      stoppedAtMs: sessionStoppedAtMs,
      nowMs: Date.now(),
    });
    if (updatedTimestamp > sessionReferenceMs) {
      cancelSessionStartEdit();
      window.alert("Diese Anfangsuhrzeit ist nicht erlaubt: Sie liegt nach dem bisherigen Sitzungsende.");
      return;
    }

    setSessionStartedAt(updatedTimestamp);
    cancelSessionStartEdit();
  }, [cancelSessionStartEdit, editingSessionStart, editingSessionStartValue, isPaused, onAir, pauseStartedAtMs, sessionStartedAt, sessionStoppedAtMs]);

  const handleSessionStartInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.currentTarget.blur();
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        cancelSessionStartEdit();
      }
    },
    [cancelSessionStartEdit],
  );

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
      if (
        isExternalView ||
        event.code !== "Space" ||
        agendaContextMenu !== null ||
        isSettingsOpen ||
        isStopConfirmOpen ||
        isHelpOpen ||
        savedSessionCandidate !== null
      ) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) {
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
  }, [advanceToNextItem, agendaContextMenu, isExternalView, isHelpOpen, isSettingsOpen, isStopConfirmOpen, rewindToPreviousItem, savedSessionCandidate]);

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
    ? formatAgendaItemLabel(currentItem, "header")
    : "Kein aktiver TOP";

  const countdownLabel = useMemo(() => {
    if (!currentItem) {
      return "--:--";
    }

    if (remainingSec > 0) {
      return formatCompact(remainingSec);
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
  const sessionStartLabel = sessionStartedAt === null ? "--:--:--" : formatTimeOfDay(sessionStartedAt);
  const lanClockSecond = Math.floor(nowMs / 1000);

  const lanSnapshot = useMemo<LanViewSnapshot | null>(() => {
    if (!lanShareUrl || isExternalView || !isTauriRuntime) {
      return null;
    }

    return {
      meetingTitle,
      meetingSubtitle,
      meetingDate,
      meetingLocation,
      onAir,
      isPaused,
      currentClock: formatTimeOfDay(lanClockSecond * 1000),
      sessionElapsed: formatClock(totalElapsedSec),
      prognosis: prognosisLabel,
      prognosisTone: prognosisClass === "deltaGreen" ? "green" : prognosisClass === "deltaRed" ? "red" : "neutral",
      currentTop: currentTopLabel,
      topElapsed: currentItem ? formatClock(currentElapsedSec) : "--:--:--",
      countdown: countdownLabel,
      countdownTone: countdownClass === "deltaGreen" ? "green" : countdownClass === "deltaRed" ? "red" : "neutral",
      sessionStart: sessionStartLabel,
      sessionEnd: scheduleTiming.sessionEndLabel,
      nextBreak: nextPlannedBreakLabel,
      hasRealAgenda: hasRealAgendaItems,
      rows: agenda.map((item) => ({
        kind: item.kind,
        state: item.state,
        stateLabel: stateLabel(item.state),
        order: item.order,
        top: item.top,
        title: item.title,
        scheduledStart: scheduleTiming.startTimeByItemId.get(item.id) ?? "--:--:--",
        duration: isPlayableAgendaItem(item) ? formatClock(shownAgendaDurationSec(item)) : "",
        isCurrent: item.id === currentItemId,
        isNext: item.id === nextItemId,
      })),
    };
  }, [
    agenda,
    countdownClass,
    countdownLabel,
    currentElapsedSec,
    currentItem,
    currentItemId,
    currentTopLabel,
    hasRealAgendaItems,
    isExternalView,
    isPaused,
    isTauriRuntime,
    lanClockSecond,
    lanShareUrl,
    meetingDate,
    meetingLocation,
    meetingSubtitle,
    meetingTitle,
    nextItemId,
    nextPlannedBreakLabel,
    onAir,
    prognosisClass,
    prognosisLabel,
    scheduleTiming,
    sessionStartLabel,
    totalElapsedSec,
  ]);

  useEffect(() => {
    if (!lanSnapshot) {
      return;
    }

    let active = true;
    void invoke("update_lan_view", { snapshot: lanSnapshot }).catch((error) => {
      if (active) {
        setLanShareMessage(`LAN-Ansicht konnte nicht aktualisiert werden: ${String(error)}`);
      }
    });

    return () => {
      active = false;
    };
  }, [lanSnapshot]);

  const toggleLanShare = async () => {
    if (lanShareBusy || !isTauriRuntime || isExternalView) {
      return;
    }

    setLanShareBusy(true);
    try {
      if (lanShareUrl) {
        await invoke("stop_lan_view");
        setLanShareUrl(null);
        setLanShareMessage("LAN-Freigabe beendet. Der bisherige Link ist ungültig.");
      } else {
        const url = await invoke<string>("start_lan_view");
        setLanShareUrl(url);
        setLanShareMessage("LAN-Ansicht aktiv. Erreichbarkeit hängt vom Firmennetz ab.");
      }
    } catch (error) {
      setLanShareMessage(`LAN-Freigabe fehlgeschlagen: ${String(error)}`);
    } finally {
      setLanShareBusy(false);
    }
  };

  const copyLanLink = async () => {
    if (!lanShareUrl) {
      return;
    }

    try {
      await invoke("copy_lan_view_link");
      setLanShareMessage("LAN-Link kopiert. Nur an berechtigte Teilnehmende weitergeben.");
    } catch (error) {
      setLanShareMessage(String(error));
    }
  };

  return (
    <main className={isAudienceView ? "appShell audienceMode" : "appShell"}>
      <header className="freezeHeader">
        <div className="headerTopRow">
          <div className="leftHeaderStack">
            <div className="logoTile" aria-label="Sitzungsbuddy Logo">
              <img src={logoOriginal} alt="Sitzungsbuddy Logo" className="logoImage" />
            </div>
            <div className="dateArea">
              {meetingDate ? <p>{meetingDate}</p> : null}
              {meetingLocation ? <strong>{meetingLocation}</strong> : null}
            </div>
          </div>

          <div className="titleArea">
            {meetingTitle ? <h1>{meetingTitle}</h1> : null}
            {meetingSubtitle ? <p className="meetingSubtitle">{meetingSubtitle}</p> : null}
          </div>

          <div className="sessionControlGroup">
            {!isAudienceView ? (
              <div className="lanShareControls" role="group" aria-label="LAN-Browseransicht">
                <button
                  type="button"
                  className={lanShareUrl ? "lanShareButton active" : "lanShareButton"}
                  onClick={toggleLanShare}
                  disabled={!isTauriRuntime || lanShareBusy}
                  aria-pressed={lanShareUrl !== null}
                  aria-label={lanShareUrl ? "LAN-Ansicht beenden" : "LAN-Ansicht starten"}
                  title={lanShareUrl ? "LAN-Ansicht beenden" : "Schreibgeschützte LAN-Ansicht aktivieren"}
                >
                  {lanShareUrl ? "LAN beenden" : "LAN starten"}
                </button>
                <button
                  type="button"
                  className="lanShareButton copy"
                  onClick={copyLanLink}
                  disabled={!lanShareUrl || lanShareBusy}
                  title="LAN-Link in die Zwischenablage kopieren"
                >
                  Link kopieren
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className={onAir ? "onAirButton active" : "onAirButton"}
              onClick={handleOnAirClick}
              aria-label={onAir ? "Sitzung beenden" : "Sitzung starten"}
              title={onAir ? "Sitzung beenden (mit Bestätigung)" : "Sitzung starten"}
              aria-pressed={onAir}
            >
              On
              <br />
              Air
            </button>

            {!isAudienceView ? (
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
            ) : null}
          </div>

          {isWindowsPlatform ? (
            <div className="windowControls" role="group" aria-label="Fenstersteuerung">
              <button
                type="button"
                className="windowControlButton"
                onClick={minimizeWindow}
                aria-label="Fenster minimieren"
                title="Minimieren"
              >
                —
              </button>
              <button
                type="button"
                className="windowControlButton"
                onClick={toggleMaximizeWindow}
                aria-label="Fenster maximieren oder wiederherstellen"
                title="Maximieren / Wiederherstellen"
              >
                □
              </button>
              <button
                type="button"
                className="windowControlButton close"
                onClick={closeWindow}
                aria-label={isAudienceView ? "Beameransicht schließen" : "Anwendung schließen"}
                title={isAudienceView ? "Beameransicht schließen" : "Schließen"}
              >
                ✕
              </button>
            </div>
          ) : null}
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

            <div className="headerTimingRow">
              <section className="headerTimingBlock">
                <p className="fieldLabel headerTimingLabel">Zeit des TOP</p>
                <div className={`${pausedValueBoxClass} headerTopTimeBox`}>
                  {currentItem ? formatClock(currentElapsedSec) : "--:--:--"}
                </div>
                <p className={`deltaValue ${countdownClass}`}>{countdownLabel}</p>
              </section>

              <section className="headerTimingBlock">
                <p className="fieldLabel headerTimingLabel">Sitzungsanfang</p>
                {isAudienceView || sessionStartedAt === null ? (
                  <div className="valueBox headerInfoValue">{sessionStartLabel}</div>
                ) : editingSessionStart ? (
                  <input
                    className="valueBox headerInfoValue sessionStartInput"
                    type="text"
                    inputMode="numeric"
                    maxLength={8}
                    value={editingSessionStartValue}
                    onChange={(event) => setEditingSessionStartValue(event.currentTarget.value)}
                    onBlur={commitSessionStartEdit}
                    onKeyDown={handleSessionStartInputKeyDown}
                    onFocus={(event) => event.currentTarget.select()}
                    autoFocus
                    aria-label="Sitzungsanfang bearbeiten (HH:MM oder HH:MM:SS)"
                  />
                ) : (
                  <button
                    type="button"
                    className="valueBox headerInfoValue sessionStartButton"
                    onClick={beginSessionStartEdit}
                    aria-label={`Sitzungsanfang ${sessionStartLabel} bearbeiten`}
                    title="Klicken, um den Sitzungsanfang zu ändern"
                  >
                    {sessionStartLabel}
                  </button>
                )}
                <p className="fieldLabel headerTimingLabel headerSecondTimingLabel">Geplantes Ende der Sitzung</p>
                <div className="valueBox headerInfoValue">{scheduleTiming.sessionEndLabel}</div>
              </section>

              <section className="headerTimingBlock">
                <p className="fieldLabel headerTimingLabel">Geplante Pause</p>
                <div className="valueBox headerInfoValue">{nextPlannedBreakLabel}</div>
              </section>
            </div>
          </section>

          {!isAudienceView ? <aside className="actionColumn">
            <div className="actionButtonRow">
              <div className="moveControlInline">
                <button
                  type="button"
                  className="iconButton moveControlButton"
                  onClick={() => moveSelectedItem(-1)}
                  disabled={!canMoveSelectedItemUp}
                  aria-label="Ausgewählte Zeilen nach oben bewegen"
                  title="Ausgewählte Zeilen nach oben bewegen"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="iconButton moveControlButton"
                  onClick={() => moveSelectedItem(1)}
                  disabled={!canMoveSelectedItemDown}
                  aria-label="Ausgewählte Zeilen nach unten bewegen"
                  title="Ausgewählte Zeilen nach unten bewegen"
                >
                  ↓
                </button>
              </div>

              <div className="actionInsertButtons">
                <button
                  type="button"
                  className="iconButton pauseInsertButton"
                  onClick={insertBreakAfterNextItem}
                  aria-label="Pause unter der nächsten Position einfügen"
                  title="Pause unter der nächsten Position einfügen"
                >
                  ⏸+
                </button>
                <button
                  type="button"
                  className="iconButton blankInsertButton"
                  onClick={insertBlankAfterNextItem}
                  aria-label="Blanko-Zeile unter der nächsten Position einfügen"
                  title="Blanko-Zeile unter der nächsten Position einfügen"
                >
                  □+
                </button>
              </div>

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
            {lanShareMessage ? <p className="lanShareMessage" role="status">{lanShareMessage}</p> : null}
            {importInfo ? <p className="importHint">{importInfo}</p> : null}
          </aside> : null}
        </div>
      </header>

      {!isAudienceView ? (
        <input
          ref={importInputRef}
          type="file"
          accept=".xlsx"
          className="hiddenFileInput"
          onChange={handleAgendaImport}
        />
      ) : null}

      <section ref={agendaScrollAreaRef} className="agendaScrollArea" onContextMenu={(event) => event.preventDefault()}>
        <article className="agendaCard">
          <h2>Agenda</h2>
          {!isAudienceView ? (
            <p className="hint">Zukünftige Punkte lassen sich per Drag & Drop oder im Bewegen-Modus (↕ + ↑/↓, Umschalt+Klick für Blöcke) umsortieren, auf Halt setzen und per Doppelklick Text/Zeit anpassen.</p>
          ) : null}
          <ul className={draggedItemId ? "agendaList draggingActive" : "agendaList"}>
            {agenda.map((item, index) => {
              const isCurrent = item.id === currentItemId;
              const isNext = item.id === nextItemId;
              const isFinished = item.state === "done" || item.state === "skipped";
              const isBreakItem = item.kind === "break";
              const isHeadingItem = item.kind === "heading";
              const isPlaceholderItem = item.kind === "placeholder";
              const isEditableDuration = !isAudienceView && !isPlaceholderItem && !isHeadingItem && (item.state === "planned" || item.state === "hold");
              const isEditableTitle = !isAudienceView && !isPlaceholderItem && (item.state === "planned" || item.state === "hold");
              const isEditingDuration = editingDurationItemId === item.id;
              const isEditingTitle = editingTitleItemId === item.id;
              const shownDurationSec = shownAgendaDurationSec(item);
              const isFuture = currentIndex < 0 || index > currentIndex;
              const canSetMoveMode =
                !isAudienceView &&
                !isPlaceholderItem &&
                isFuture &&
                movableStates.includes(item.state);
              const isInMoveMode = movingItemIds.has(item.id);
              const canToggleHold =
                !isAudienceView && !isPlaceholderItem && isFuture && (item.state === "planned" || item.state === "hold");
              const canDragItem =
                !isAudienceView &&
                !isPlaceholderItem &&
                isFuture &&
                movableStates.includes(item.state);
              const canDeleteItem = canDragItem;
              const dropIndicator = dragOverTarget?.itemId === item.id ? dragOverTarget.position : null;
              const scheduledStartLabel = scheduleTiming.startTimeByItemId.get(item.id) ?? "--:--:--";
              const agendaItemClassName = [
                "agendaItem",
                isBreakItem ? "pauseItem" : "",
                isHeadingItem ? "headingItem" : "",
                isPlaceholderItem ? "placeholderItem" : "",
                isCurrent ? "current" : "",
                isNext ? "next" : "",
                item.state === "hold" ? "onHold" : "",
                isFinished ? "finished" : "",
                isInMoveMode ? "moveModeItem" : "",
                canDragItem ? "draggableItem" : "",
                draggedItemId === item.id ? "draggingItem" : "",
                dropIndicator === "before" ? "dropBefore" : "",
                dropIndicator === "after" ? "dropAfter" : "",
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
                  title={isEditableTitle ? "Doppelklick zum Bearbeiten" : undefined}
                >
                  {item.title}
                </span>
              );

              return (
                <li
                  key={item.id}
                  className={agendaItemClassName}
                  data-item-id={item.id}
                  onMouseDown={canDragItem ? (event) => beginMouseDrag(event, item.id, canDragItem) : undefined}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!canDeleteItem) {
                      setAgendaContextMenu(null);
                      return;
                    }

                    setAgendaContextMenu({
                      itemId: item.id,
                      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 208)),
                      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 64)),
                    });
                  }}
                  title={canDragItem ? "Zum Verschieben ziehen und zwischen den Zeilen loslassen" : undefined}
                  aria-grabbed={draggedItemId === item.id}
                >
                  {dropIndicator ? (
                    <span className={dropIndicator === "before" ? "dropHint top" : "dropHint bottom"}>Hier einfügen</span>
                  ) : null}
                  <div className="agendaMeta">
                    {canDragItem ? <span className="dragHandle" aria-hidden="true">⋮⋮</span> : null}
                    {isPlaceholderItem ? (
                      item.title ? <span className="placeholderTitle">{item.title}</span> : <span className="placeholderSpacer" aria-hidden="true" />
                    ) : isBreakItem ? (
                      <>
                        <span className={`badge state-${item.state}`}>Pause</span>
                        <span className="order">#{item.order}</span>
                        <span className="scheduleTime">{scheduledStartLabel}</span>
                        {titleElement}
                      </>
                    ) : isHeadingItem ? (
                      <>
                        <span className="badge headingBadge">Überschrift</span>
                        {item.top.trim() ? <span className="headingNumber">{item.top}</span> : null}
                        {titleElement}
                      </>
                    ) : (
                      <>
                        <span className={`badge state-${item.state}`}>{stateLabel(item.state)}</span>
                        <span className="order">#{item.order}</span>
                        <span className="scheduleTime">{scheduledStartLabel}</span>
                        {item.top.trim() ? <span className="top">TOP {item.top}</span> : null}
                        {titleElement}
                      </>
                    )}
                  </div>
                  {!isPlaceholderItem && (!isAudienceView || !isHeadingItem) ? (
                    <div className={isAudienceView ? "agendaActions audienceAgendaActions" : "agendaActions"}>
                      {isHeadingItem ? null : isEditingDuration ? (
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
                          title={isEditableDuration ? "Doppelklick zum Bearbeiten" : undefined}
                        >
                          {formatClock(shownDurationSec)}
                        </span>
                      )}
                      {!isAudienceView ? (
                        <>
                          <button
                            type="button"
                            className={isInMoveMode ? "mini moveModeToggle active" : "mini moveModeToggle"}
                            onClick={(event) => toggleMoveMode(item.id, event.shiftKey)}
                            disabled={!canSetMoveMode}
                            aria-pressed={isInMoveMode}
                            aria-label={isInMoveMode && moveSelection?.itemIds.length === 1 ? "Bewegen-Modus beenden" : "Zeile für Bewegen-Modus auswählen"}
                            title="Klick: einzelne Zeile auswählen · Umschalt+Klick: Block auswählen"
                          >
                            ↕
                          </button>
                          <button
                            type="button"
                            className="mini wide"
                            onClick={() => toggleHold(index)}
                            disabled={!canToggleHold}
                          >
                            {item.state === "hold" ? "Fortsetzen" : "Halt"}
                          </button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
            {hasRealAgendaItems ? (
              <li className="agendaEndRow">
                <div className="agendaMeta">
                  <span className="badge agendaEndBadge">Sitzungsende</span>
                </div>
                <div className={isAudienceView ? "agendaActions audienceAgendaActions" : "agendaActions"}>
                  <span className="duration agendaEndTime">{scheduleTiming.sessionEndLabel}</span>
                </div>
              </li>
            ) : null}
          </ul>
        </article>

        {!isAudienceView ? <article className="asRunCard">
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
                  <span
                    className={[
                      "asRunCell",
                      "asRunVariance",
                      entry.varianceSec > 0
                        ? "over"
                        : entry.varianceSec < 0
                          ? "under"
                          : "neutral",
                    ].join(" ")}
                  >
                    Abw. {entry.varianceLabel}
                  </span>
                  <span className={entry.isLive ? "asRunBadge live" : "asRunBadge done"}>
                    {entry.isLive ? "Läuft" : "Fertig"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </article> : null}
      </section>

      {agendaContextMenu ? (
        <div
          className="agendaContextMenu"
          role="menu"
          aria-label="Aktionen für Agenda-Position"
          style={{ left: agendaContextMenu.x, top: agendaContextMenu.y }}
        >
          <button type="button" role="menuitem" onClick={() => deleteFutureItem(agendaContextMenu.itemId)} autoFocus>
            Position löschen
          </button>
        </div>
      ) : null}

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
            <p className="helpCaption">
              Beispielansicht der Oberfläche; einzelne Bedienelemente können inzwischen anders aussehen.
            </p>

            <h4 className="helpSectionTitle">1) Kopfbereich</h4>
            <p className="helpText">
              Oben links stehen Datum und Ort. In der Mitte stehen Haupttitel und Untertitel der Sitzung (Untertitel kommt aus
              Excel-Zelle A4). Unter der Trennlinie zeigt die linke Seite aktuelle Uhrzeit, Sitzungszeit und Prognose. Rechts
              siehst du den aktiven TOP, die laufende TOP-Zeit und den Countdown zur geplanten Dauer. Daneben stehen in
              beiden Ansichten der <strong>Sitzungsanfang</strong>, darunter das <strong>geplante Ende der Sitzung</strong>
              (berechnet aus Startzeit und Agenda) sowie die <strong>geplante Pause</strong> (Uhrzeit der nächsten Pausenzeile).
              Diese Werte werden bei Änderungen oder Triggern automatisch aktualisiert. Wenn ein externer Monitor erkannt
              wird, öffnet sich dort eine reduzierte Beamer-Ansicht ohne Operator-Bedienelemente. Sie macht den Sitzungsstand
              für alle Teilnehmenden transparent.
            </p>
            <p className="helpText">
              Das Feld <strong>Sitzungsanfang bearbeiten</strong> zeigt die Uhrzeit des ersten OnAir-Starts. In der
              Hauptansicht klickst du auf die Uhrzeit und gibst eine neue Zeit als HH:MM oder HH:MM:SS ein. Mit
              <strong> Enter</strong> oder einem Klick außerhalb des Feldes übernimmst du sie; mit
              <strong> Escape</strong> verwirfst du die Eingabe. Ungültige Uhrzeiten, Zeiten in der Zukunft oder nach dem
              bisherigen Sitzungsende werden mit einer Meldung abgelehnt; die vorherige Startzeit bleibt erhalten. Eine
              gültige Änderung aktualisiert die Sitzungsdauer, die berechneten TOP-Uhrzeiten und das geplante Sitzungsende.
              Die Beamer-Ansicht zeigt den geänderten Sitzungsanfang ebenfalls an, lässt ihn aber nicht bearbeiten.
            </p>
            <p className="helpText">
              Mit <strong>LAN starten</strong> im Kopfbereich aktivierst du eine zusätzliche, schreibgeschützte Browseransicht.
              <strong> Link kopieren</strong> kopiert den Zugangslink für berechtigte Personen im selben Netzwerk. Die
              Browseransicht aktualisiert sich automatisch und hat keine Steuerknöpfe. Mit <strong>LAN beenden</strong>
              schließt du die Freigabe; der alte Link funktioniert danach nicht mehr. Eine Firmen-Firewall oder getrennte
              WLAN-Bereiche können den Zugriff verhindern, ohne die Sitzung in Sitzungsbuddy zu stören. Der Link ist ein
              Zugangsschlüssel; die lokale HTTP-Verbindung ist nicht verschlüsselt. Vertrauliche Agenden nur nach Freigabe
              durch eure IT teilen.
            </p>

            <h4 className="helpSectionTitle">2) Session-Steuerung</h4>
            <p className="helpText">
              Ein Klick auf den grauen <strong>OnAir</strong>-Knopf startet die Sitzung. Ist OnAir bereits aktiv (rot),
              öffnet ein erneuter Klick die Frage, ob die Sitzung beendet werden soll – mit den Optionen
              <strong> Nein</strong>, <strong>Ja, ohne Speichern</strong> und <strong>Ja + Speichern</strong>.
              <strong> Pause (❚❚/▶)</strong> hält alle Zeiten an; währenddessen blinken Sitzungszeit und TOP-Zeit im
              Sekundentakt. Auch während einer Pause kannst du die Sitzung über OnAir beenden.
            </p>

            <h4 className="helpSectionTitle">3) Rechte Funktionsknöpfe</h4>
            <p className="helpText">
              <strong>Pause einfügen (⏸+)</strong> legt unter dem nächsten offenen Punkt eine zusätzliche Pausenzeile mit
              Standarddauer 05:00 an. <strong>Blanko-Zeile (□+)</strong> fügt darunter einen neutralen Eintrag (nicht gelb)
              mit 05:00 ein, den du frei umbenennen kannst. <strong>Zahnrad</strong> öffnet Einstellungen, Impressum und
              Hilfe. <strong> Export</strong> erzeugt ein AsRun-Log als PDF (mit Dateidialog). <strong>Import</strong> lädt
              eine Agenda aus Excel (.xlsx).
            </p>

            <h4 className="helpSectionTitle">4) Agenda-Liste</h4>
            <p className="helpText">
              Der laufende TOP oder die laufende Pause ist rot markiert, der nächste Eintrag grün. Auf Halt gesetzte Zeilen
              sind hellgelb; Pausenzeilen ohne diese Zustände sind beige. Bereits gesendete normale TOPs werden ausgegraut.
              Zukünftige Einträge lassen sich umsortieren und über <strong>Halt</strong> temporär sperren.
              Per Rechtsklick kannst du eine noch nicht gesendete Position löschen; gesendete Positionen bleiben erhalten.
              Pausenzeilen verhalten sich beim Triggern wie normale Agendaeinträge. Hellblaue
              Überschriften gliedern die Agenda, haben aber weder eine eigene Laufzeit noch eine Startuhrzeit. Ohne Import
              zeigt die Liste standardmäßig Hinweise zum Agenda-Import.
            </p>

            <h4 className="helpSectionTitle">5) Zeilen bewegen</h4>
            <p className="helpText">
              <strong>Eine Zeile:</strong> Klicke rechts in einer noch nicht gesendeten Zeile auf <strong>↕</strong>.
              Die Zeile wird sichtbar markiert und ist im Bewegen-Modus. Mit den großen <strong>↑</strong>- und
              <strong> ↓</strong>-Knöpfen oben im Kopfbereich verschiebst du sie pro Klick um eine Position. Du kannst
              denselben Pfeil mehrfach anklicken, ohne die Zeile erneut auszuwählen. Ein weiterer Klick auf ihren
              <strong> ↕</strong>-Knopf beendet die Auswahl; ein Klick auf den ↕-Knopf einer anderen Zeile wechselt die
              Auswahl dorthin.
            </p>
            <p className="helpText">
              <strong>Mehrere Zeilen:</strong> Wähle zuerst mit ↕ eine Zeile aus. Halte dann <strong>Shift</strong>
              (Umschalttaste) gedrückt und klicke auf ↕ in einer weiteren Zeile. Alle Zeilen dazwischen werden als
              zusammenhängender Block markiert. Die Pfeile oben bewegen den gesamten Block gemeinsam; seine interne
              Reihenfolge bleibt erhalten. Mit einem normalen Klick auf ↕ wechselst du wieder zur Einzelauswahl.
              Bewegen lassen sich nur zukünftige, geplante oder auf Halt gesetzte Zeilen – nicht der laufende TOP und nicht
              bereits gesendete Zeilen.
            </p>
            <p className="helpText">
              Alternativ kannst du eine einzelne zukünftige Zeile mit der Maus ziehen und zwischen anderen zukünftigen
              Zeilen fallen lassen. Während des Ziehens zeigt eine Einfügemarkierung die Zielposition an.
            </p>

            <h4 className="helpSectionTitle">6) Text- und Zeitbearbeitung</h4>
            <p className="helpText">
              Bei zukünftigen bzw. gehaltenen Punkten kannst du mit Doppelklick den <strong>Titeltext</strong> und die
              <strong> geplante Dauer</strong> direkt in der Liste bearbeiten (Enter = übernehmen, Esc = abbrechen). Das gilt
              auch für eingefügte Pausen- und Blanko-Zeilen. Bei Überschriften ist nur der Text editierbar.
            </p>

            <h4 className="helpSectionTitle">7) Triggern per Tastatur</h4>
            <p className="helpText">
              <strong>Leertaste</strong> triggert vorwärts zum nächsten TOP. <strong>Strg + Leertaste</strong> nimmt das letzte
              Triggern zurück und holt den vorherigen TOP oder die vorherige Pause wieder auf Sendung.
              Dazwischenliegende Überschriften werden in beide Richtungen automatisch übersprungen. <strong>Esc</strong>
              schließt geöffnete Dialoge.
            </p>

            <h4 className="helpSectionTitle">8) Excel-Import</h4>
            <p className="helpText">
              Beim Import werden folgende Felder gelesen: <strong>A1</strong> Haupttitel, <strong>A4</strong> Untertitel,
              <strong> B2</strong> Ort und <strong>B3</strong> Datum. Die Agenda beginnt unter der Spaltenüberschrift,
              normalerweise ab Zeile 6: <strong>A</strong> = TOP- oder Abschnittsnummer, <strong>B</strong> = Titel,
              <strong> C</strong> = geplante Dauer in Minuten und <strong>D</strong> = Sitzungstag oder Eigenschaft.
              Eine Zahl in D, etwa <strong>1</strong> oder <strong>2</strong>, ordnet einen TOP dem jeweiligen Sitzungstag zu.
              Die Kennbuchstaben P und U können auch kleingeschrieben werden. Die tatsächliche Startzeit der Sitzung beginnt
              erst mit <strong>OnAir</strong>.
            </p>
            <p className="helpText">
              <strong>P = Pause:</strong> Steht in D ein P, wird die Zeile als beige Pause importiert – genauso wie
              bei „Pause einfügen“. Der Text in B ist frei wählbar; bleibt B leer, heißt der Eintrag „Pause“. In C steht die
              geplante Länge in Minuten; ohne Angabe gelten fünf Minuten. Eine TOP-Nummer in A ist nicht nötig. Die Pause
              zählt bei der Berechnung des Sitzungsendes mit, kann wie ein normaler Eintrag getriggert werden und erscheint
              im Kopfbereich beider Ansichten als Uhrzeit der nächsten geplanten Pause.
            </p>
            <p className="helpText">
              <strong>U = Überschrift:</strong> Steht in D ein U, wird die Zeile als hellblaue Abschnittsüberschrift
              importiert. Der Titel steht in B; eine optionale Abschnittsnummer aus A wird ohne „TOP“ davor angezeigt.
              Spalte C spielt hier keine Rolle: Die Überschrift hat weder Dauer noch eigene Startuhrzeit und erscheint nicht im
              AsRun-Log. Beim Start mit OnAir oder beim Triggern mit der Leertaste springt die App direkt zum nächsten TOP
              oder zur nächsten Pause. Auch beim Zurücktriggern wird die Überschrift übersprungen.
            </p>

            <h4 className="helpSectionTitle">9) AsRun-Export</h4>
            <p className="helpText">
              Das PDF enthält alle bereits gesendeten Einträge inklusive Startzeit, geplanter Dauer und Ist-Dauer. Über die
              Filter oberhalb der Vorschau kannst du zwischen "nur fertige" und "inkl. laufendem" Eintrag wechseln. In der
              Vorschau und im PDF siehst du zusätzlich die <strong>Abweichung (Abw.)</strong> als +/−-Wert zwischen geplanter
              und tatsächlicher Dauer.
            </p>

            <h4 className="helpSectionTitle">10) Sitzung speichern und fortführen</h4>
            <p className="helpText">
              Wenn du beim Beenden über <strong>OnAir</strong> „Ja + Speichern“ wählst, wird der aktuelle Stand lokal
              gesichert. Beim nächsten Start fragt die App automatisch, ob der letzte Stand fortgeführt werden soll.
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
