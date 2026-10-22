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
import readXlsxFile, { type Sheet as ImportedSheet } from "read-excel-file/browser";
import helpOverviewImage from "./assets/help-overview.png";
import logoOriginal from "./assets/sitzungsbuddy-logo-original.png";
import { fnv1aHash } from "./lib/checksum";
import "./App.css";

type AgendaState = "planned" | "live" | "hold" | "done" | "skipped";
type AgendaKind = "topic" | "break" | "placeholder";

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
  varianceSec: number;
  plannedLabel: string;
  actualLabel: string;
  varianceLabel: string;
  isLive: boolean;
};

type AsRunFilter = "completed" | "all";
type ImportedSheetData = ImportedSheet["data"];
type DropPosition = "before" | "after";

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
const maxImportDurationSec = 12 * 60 * 60;
const maxAgendaTopLength = 32;
const maxAgendaTitleLength = 180;
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
      rawItem.kind === "break" ? "break" : rawItem.kind === "placeholder" ? "placeholder" : "topic";
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
    const topFallback = kind === "break" ? "PAUSE" : kind === "placeholder" ? "" : String(index + 1);
    const top = sanitizeImportedText(String(rawItem.top ?? topFallback), 64) || topFallback;
    const titleFallback = kind === "break" ? "Pause" : kind === "placeholder" ? "" : `TOP ${top}`;
    const title = sanitizeImportedText(String(rawItem.title ?? titleFallback), 200) || titleFallback;

    const durationFallback = kind === "placeholder" ? 0 : 300;
    const durationSec = Math.round(readNonNegativeNumber(rawItem.plannedDurationSec, durationFallback));
    const plannedDurationSec = kind === "placeholder" ? 0 : Math.max(60, durationSec);

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

function normalizeOrder(items: AgendaItem[]): AgendaItem[] {
  return items.map((item, index) => ({ ...item, order: index + 1 }));
}

function hasSameAgendaBlueprint(left: AgendaItem[], right: AgendaItem[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((item, index) => {
    const candidate = right[index];
    if (!candidate) {
      return false;
    }

    return (
      item.kind === candidate.kind &&
      item.day === candidate.day &&
      item.top === candidate.top &&
      item.title === candidate.title &&
      item.plannedDurationSec === candidate.plannedDurationSec
    );
  });
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

  if (item.kind === "placeholder") {
    return item.title;
  }

  const topText = item.top.trim();
  const titleText = item.title.trim();
  if (topText && titleText) {
    return `${topText}${style === "header" ? ". " : " "}${titleText}`;
  }

  return topText || titleText || "Ohne Titel";
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

function decodeCellAddress(address: string): { row: number; column: number } | null {
  const match = address.trim().match(/^([A-Za-z]+)(\d+)$/);
  if (!match) {
    return null;
  }

  const columnLabel = match[1].toUpperCase();
  const row = Number(match[2]);
  if (!Number.isInteger(row) || row <= 0) {
    return null;
  }

  let column = 0;
  for (const character of columnLabel) {
    const code = character.charCodeAt(0) - 64;
    if (code < 1 || code > 26) {
      return null;
    }

    column = column * 26 + code;
  }

  return { row, column };
}

function getCellValue(sheet: ImportedSheetData, row: number, column: number): unknown {
  const rowData = sheet[row - 1];
  if (!rowData || column <= 0 || column > rowData.length) {
    return undefined;
  }

  return rowData[column - 1];
}

function readCellText(sheet: ImportedSheetData, address: string): string {
  const decodedAddress = decodeCellAddress(address);
  if (!decodedAddress) {
    return "";
  }

  const cellValue = getCellValue(sheet, decodedAddress.row, decodedAddress.column);
  if (cellValue === null || cellValue === undefined) {
    return "";
  }

  if (cellValue instanceof Date) {
    return sanitizeImportedText(cellValue.toLocaleDateString("de-DE"), 120);
  }

  return sanitizeImportedText(String(cellValue));
}

function readLabeledValue(sheet: ImportedSheetData, labelPattern: RegExp): string {
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

function parseDurationCell(cell?: unknown): number | null {
  if (cell === null || cell === undefined || cell === "") {
    return null;
  }

  if (cell instanceof Date) {
    return cell.getHours() * 3600 + cell.getMinutes() * 60 + cell.getSeconds();
  }

  if (typeof cell === "number") {
    if (cell > 0 && cell < 1) {
      return Math.round(cell * 24 * 60 * 60);
    }

    if (cell >= 1 && cell < 1000) {
      return Math.round(cell * 60);
    }
  }

  const valueText = String(cell).trim();
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

function parseDayLabel(dayCell: unknown, topValue: string): string {
  if (dayCell !== null && dayCell !== undefined && String(dayCell).trim() !== "") {
    if (typeof dayCell === "number") {
      const dayFromNumber = Math.max(1, Math.round(dayCell));
      return `Tag ${dayFromNumber}`;
    }

    const dayText = String(dayCell).trim();
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

function findAgendaStartRow(sheet: ImportedSheetData): number {
  for (let row = 1; row <= 40; row += 1) {
    const leftValue = readCellText(sheet, `A${row}`).toLowerCase();
    const titleValue = readCellText(sheet, `B${row}`).toLowerCase();
    if (leftValue === "top" && titleValue.includes("titel")) {
      return row + 1;
    }
  }

  return 6;
}

function hasUnexpectedAgendaColumns(sheet: ImportedSheetData, row: number): boolean {
  const rowValues = sheet[row - 1];
  if (!Array.isArray(rowValues)) {
    return false;
  }

  for (let columnIndex = 5; columnIndex < rowValues.length; columnIndex += 1) {
    const value = rowValues[columnIndex];
    if (value === null || value === undefined) {
      continue;
    }

    if (String(value).trim() !== "") {
      return true;
    }
  }

  return false;
}

function buildImportedAgenda(sheet: ImportedSheetData): AgendaItem[] {
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

    if (hasUnexpectedAgendaColumns(sheet, row)) {
      throw new Error(`Unerwartete Daten in Spalten rechts von E (Zeile ${row}).`);
    }

    if (topValue.length > maxAgendaTopLength) {
      throw new Error(`TOP-Nummer in Zeile ${row} ist zu lang (max. ${maxAgendaTopLength} Zeichen).`);
    }

    if (titleValue.length > maxAgendaTitleLength) {
      throw new Error(`TOP-Titel in Zeile ${row} ist zu lang (max. ${maxAgendaTitleLength} Zeichen).`);
    }

    const durationSec = parseDurationCell(getCellValue(sheet, row, 3)) ?? 15 * 60;
    if (durationSec <= 0 || durationSec > maxImportDurationSec) {
      throw new Error(`Ungültige TOP-Dauer in Zeile ${row}.`);
    }

    const dayLabel = parseDayLabel(getCellValue(sheet, row, 4), topValue);

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
  const [savedSessionCandidate, setSavedSessionCandidate] = useState<PersistedSession | null>(null);
  const [movingItemId, setMovingItemId] = useState<string | null>(null);
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<{ itemId: string; position: DropPosition } | null>(null);

  const hasRealAgendaItems = useMemo(
    () => agenda.some((item) => item.kind === "topic" || item.kind === "break"),
    [agenda],
  );

  const currentIndex = useMemo(
    () => agenda.findIndex((item) => item.id === currentItemId),
    [agenda, currentItemId],
  );

  const currentItem = currentIndex >= 0 ? agenda[currentIndex] : null;
  const firstFutureIndex = currentIndex < 0 ? 0 : currentIndex + 1;

  const movingItemIndex = useMemo(() => {
    if (!movingItemId) {
      return -1;
    }

    return agenda.findIndex((item) => item.id === movingItemId);
  }, [agenda, movingItemId]);

  const movingItem = movingItemIndex >= 0 ? agenda[movingItemIndex] : null;

  const canMoveSelectedItemUp =
    movingItem !== null &&
    movingItem.kind !== "placeholder" &&
    movableStates.includes(movingItem.state) &&
    movingItemIndex > firstFutureIndex;

  const canMoveSelectedItemDown =
    movingItem !== null &&
    movingItem.kind !== "placeholder" &&
    movableStates.includes(movingItem.state) &&
    movingItemIndex >= firstFutureIndex &&
    movingItemIndex < agenda.length - 1 &&
    movableStates.includes(agenda[movingItemIndex + 1]?.state ?? "planned") &&
    (agenda[movingItemIndex + 1]?.kind ?? "placeholder") !== "placeholder";

  const nextItemId = useMemo(() => {
    const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
    const nextPlanned = agenda.find(
      (item, index) => index >= startIndex && item.kind !== "placeholder" && item.state === "planned",
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
      .filter((item) => item.actualStartedAtMs !== null)
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
      (item, index) => index > currentIndexInAgenda && item.kind !== "placeholder" && item.state === "planned",
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
  }, [agenda, currentItemId, isExternalView, isPaused, onAir]);

  const startOnAir = useCallback(() => {
    if (isExternalView) {
      return;
    }

    if (onAir) {
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

    const firstPlanned = agenda.find((item) => item.kind !== "placeholder" && item.state === "planned");
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

  const stopSession = useCallback(() => {
    if (isExternalView || (!onAir && !isPaused)) {
      return;
    }

    setIsStopConfirmOpen(true);
  }, [isExternalView, isPaused, onAir]);

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
    setSessionStoppedAtMs(null);
    setCurrentItemId(null);
    setCurrentItemStartedAt(null);
    setCurrentItemStoppedAtMs(null);
    setEditingDurationItemId(null);
    setEditingDurationValue("");
    setEditingTitleItemId(null);
    setEditingTitleValue("");
    setAsRunFilter("all");
    setMovingItemId(null);
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

        setImportInfo(`Import erfolgreich (${importedAgenda.length} TOPs).`);
      } catch (error) {
        console.error("Agenda import failed", error);
        setImportInfo("Import fehlgeschlagen. Bitte Datei und Format prüfen (A=TOP, B=Titel, C=Dauer, D=Tag, optional E=Uhrzeit).");
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

  const moveFutureItem = useCallback(
    (itemId: string, direction: -1 | 1) => {
      setAgenda((previous) => {
        const index = previous.findIndex((item) => item.id === itemId);
        if (index < 0) {
          return previous;
        }

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

  const toggleMoveMode = useCallback(
    (itemId: string) => {
      setMovingItemId((previous) => {
        if (previous === itemId) {
          return null;
        }

        const index = agenda.findIndex((item) => item.id === itemId);
        if (index < firstFutureIndex) {
          return previous;
        }

        const candidate = agenda[index];
        if (!candidate || candidate.kind === "placeholder" || !movableStates.includes(candidate.state)) {
          return previous;
        }

        return itemId;
      });
    },
    [agenda, firstFutureIndex],
  );

  const moveSelectedItem = useCallback(
    (direction: -1 | 1) => {
      if (!movingItemId) {
        return;
      }

      moveFutureItem(movingItemId, direction);
    },
    [moveFutureItem, movingItemId],
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
    if (!movingItemId) {
      return;
    }

    const selectedIndex = agenda.findIndex((item) => item.id === movingItemId);
    if (selectedIndex < firstFutureIndex) {
      setMovingItemId(null);
      return;
    }

    const selectedItem = agenda[selectedIndex];
    if (!selectedItem || selectedItem.kind === "placeholder" || !movableStates.includes(selectedItem.state)) {
      setMovingItemId(null);
    }
  }, [agenda, firstFutureIndex, movingItemId]);

  useEffect(() => {
    dragOverTargetRef.current = dragOverTarget;
  }, [dragOverTarget]);

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
  }, [advanceToNextItem, isExternalView, isHelpOpen, isSettingsOpen, isStopConfirmOpen, rewindToPreviousItem, savedSessionCandidate]);

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
            <button
              type="button"
              className={onAir ? "onAirButton active" : "onAirButton"}
              onClick={startOnAir}
              aria-label={onAir ? "OnAir aktiv" : "OnAir inaktiv"}
            >
              On
              <br />
              Air
            </button>

            {!isAudienceView ? (
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

            {isAudienceView ? (
              <div className="audienceTimingRow">
                <section className="audienceTimingBlock audienceCurrentTimeBlock">
                  <p className="fieldLabel audienceFieldLabel">Zeit des TOP</p>
                  <div className={`${pausedValueBoxClass} audienceTopTimeBox`}>
                    {currentItem ? formatClock(currentElapsedSec) : "--:--:--"}
                  </div>
                  <p className={`deltaValue ${countdownClass} audienceCountdown`}>{countdownLabel}</p>
                </section>

                <section className="audienceTimingBlock audienceInfoBox">
                  <p className="fieldLabel audienceFieldLabel">Geplantes Ende der Sitzung</p>
                  <div className="valueBox audienceInfoValue">{scheduleTiming.sessionEndLabel}</div>
                </section>

                <section className="audienceTimingBlock audienceInfoBox">
                  <p className="fieldLabel audienceFieldLabel">Geplante Pause</p>
                  <div className="valueBox audienceInfoValue">{nextPlannedBreakLabel}</div>
                </section>
              </div>
            ) : (
              <>
                <p className="fieldLabel">Zeit des TOP</p>
                <div className={pausedValueBoxClass}>{currentItem ? formatClock(currentElapsedSec) : "--:--:--"}</div>

                <p className={`deltaValue ${countdownClass}`}>{countdownLabel}</p>
              </>
            )}
          </section>

          {!isAudienceView ? <aside className="actionColumn">
            <div className="actionButtonRow">
              <div className="moveControlInline">
                <button
                  type="button"
                  className="iconButton moveControlButton"
                  onClick={() => moveSelectedItem(-1)}
                  disabled={!canMoveSelectedItemUp}
                  aria-label="Ausgewählte Zeile nach oben bewegen"
                  title="Ausgewählte Zeile nach oben bewegen"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="iconButton moveControlButton"
                  onClick={() => moveSelectedItem(1)}
                  disabled={!canMoveSelectedItemDown}
                  aria-label="Ausgewählte Zeile nach unten bewegen"
                  title="Ausgewählte Zeile nach unten bewegen"
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

      <section ref={agendaScrollAreaRef} className="agendaScrollArea">
        <article className="agendaCard">
          <h2>Agenda</h2>
          {!isAudienceView ? (
            <p className="hint">Zukünftige Punkte lassen sich per Drag & Drop oder im Bewegen-Modus (↕ + ↑/↓) umsortieren, auf Halt setzen und per Doppelklick Text/Zeit anpassen.</p>
          ) : null}
          <ul className={draggedItemId ? "agendaList draggingActive" : "agendaList"}>
            {agenda.map((item, index) => {
              const isCurrent = item.id === currentItemId;
              const isNext = item.id === nextItemId;
              const isFinished = item.state === "done" || item.state === "skipped";
              const isBreakItem = item.kind === "break";
              const isPlaceholderItem = item.kind === "placeholder";
              const isEditableDuration = !isAudienceView && !isPlaceholderItem && (item.state === "planned" || item.state === "hold");
              const isEditableTitle = !isAudienceView && !isPlaceholderItem && (item.state === "planned" || item.state === "hold");
              const isEditingDuration = editingDurationItemId === item.id;
              const isEditingTitle = editingTitleItemId === item.id;
              const shownDurationSec =
                item.state === "done" && item.actualStartedAtMs !== null && item.actualEndedAtMs !== null
                  ? Math.max(0, Math.floor((item.actualEndedAtMs - item.actualStartedAtMs - item.actualPausedMsTotal) / 1000))
                  : item.state === "skipped"
                    ? 0
                    : item.plannedDurationSec;
              const isFuture = currentIndex < 0 || index > currentIndex;
              const canSetMoveMode =
                !isAudienceView &&
                !isPlaceholderItem &&
                isFuture &&
                movableStates.includes(item.state);
              const isInMoveMode = movingItemId === item.id;
              const canToggleHold =
                !isAudienceView && !isPlaceholderItem && isFuture && (item.state === "planned" || item.state === "hold");
              const canDragItem =
                !isAudienceView &&
                !isPlaceholderItem &&
                isFuture &&
                movableStates.includes(item.state);
              const dropIndicator = dragOverTarget?.itemId === item.id ? dragOverTarget.position : null;
              const scheduledStartLabel = scheduleTiming.startTimeByItemId.get(item.id) ?? "--:--:--";
              const agendaItemClassName = [
                "agendaItem",
                isBreakItem ? "pauseItem" : "",
                isPlaceholderItem ? "placeholderItem" : "",
                isCurrent ? "current" : "",
                isNext ? "next" : "",
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
                  {!isPlaceholderItem ? (
                    <div className={isAudienceView ? "agendaActions audienceAgendaActions" : "agendaActions"}>
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
                            onClick={() => toggleMoveMode(item.id)}
                            disabled={!canSetMoveMode}
                            aria-label={isInMoveMode ? "Bewegen-Modus beenden" : "Zeile für Bewegen-Modus auswählen"}
                            title={isInMoveMode ? "Bewegen-Modus beenden" : "Zeile für Bewegen-Modus auswählen"}
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
              siehst du den aktiven TOP, die laufende TOP-Zeit und den Countdown zur geplanten Dauer. Wenn ein externer
              Monitor erkannt wird, öffnet sich dort automatisch eine reduzierte Beamer-Ansicht ohne Operator-Bedienelemente.
              Diese Anzeige macht den aktuellen Sitzungsstand für alle Teilnehmenden transparent. In der Beamer-Ansicht siehst
              du zusätzlich die Felder <strong>Geplantes Ende der Sitzung</strong> (berechnet aus Startzeit und Agenda) und
              <strong> Geplante Pause</strong> (Uhrzeit der nächsten Pausenzeile); beide Werte werden bei Änderungen oder
              Triggern automatisch aktualisiert.
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
              Standarddauer 05:00 an. <strong>Blanko-Zeile (□+)</strong> fügt darunter einen neutralen Eintrag (nicht gelb)
              mit 05:00 ein, den du frei umbenennen kannst. <strong>Zahnrad</strong> öffnet Einstellungen, Impressum und
              Hilfe. <strong> Export</strong> erzeugt ein AsRun-Log als PDF (mit Dateidialog). <strong>Import</strong> lädt
              eine Agenda aus Excel (.xlsx).
            </p>

            <h4 className="helpSectionTitle">4) Agenda-Liste</h4>
            <p className="helpText">
              Der aktuelle TOP ist gelb/grün markiert, der nächste TOP orange. Bereits gesendete Einträge werden ausgegraut.
              Zukünftige Einträge lassen sich mit den Pfeilen umsortieren und über <strong>Halt</strong> temporär sperren.
              Pausenzeilen sind leuchtend gelb dargestellt und verhalten sich wie normale Agendaeinträge. Ohne Import zeigt die
              Liste standardmäßig Hinweise zum Agenda-Import.
            </p>

            <h4 className="helpSectionTitle">5) Text- und Zeitbearbeitung</h4>
            <p className="helpText">
              Bei zukünftigen bzw. gehaltenen Punkten kannst du mit Doppelklick den <strong>Titeltext</strong> und die
              <strong> geplante Dauer</strong> direkt in der Liste bearbeiten (Enter = übernehmen, Esc = abbrechen). Das gilt
              auch für eingefügte Pausen- und Blanko-Zeilen.
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
              Filter oberhalb der Vorschau kannst du zwischen "nur fertige" und "inkl. laufendem" Eintrag wechseln. In der
              Vorschau und im PDF siehst du zusätzlich die <strong>Abweichung (Abw.)</strong> als +/−-Wert zwischen geplanter
              und tatsächlicher Dauer.
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
