import type { Sheet as ImportedSheet } from "read-excel-file/browser";
import { sanitizeImportedText, type AgendaItem, type AgendaKind } from "./agenda";

type ImportedSheetData = ImportedSheet["data"];

const maxImportDurationSec = 12 * 60 * 60;
const maxAgendaTopLength = 32;
const maxAgendaTitleLength = 180;

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

export function readCellText(sheet: ImportedSheetData, address: string): string {
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

export function readLabeledValue(sheet: ImportedSheetData, labelPattern: RegExp): string {
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

  // Excel speichert Uhrzeiten als Tagesbruchteil; ganze Werte unter 1000 sind Minuten.
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

function findFollowingDayLabel(sheet: ImportedSheetData, row: number): string | null {
  for (let followingRow = row + 1; followingRow <= 600; followingRow += 1) {
    const dayCell = getCellValue(sheet, followingRow, 4);
    if (typeof dayCell === "number" || (typeof dayCell === "string" && /^\d+$/.test(dayCell.trim()))) {
      return parseDayLabel(dayCell, readCellText(sheet, `A${followingRow}`));
    }
  }

  return null;
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

export function buildImportedAgenda(sheet: ImportedSheetData): AgendaItem[] {
  const imported: AgendaItem[] = [];
  let blankStreak = 0;
  const startRow = findAgendaStartRow(sheet);

  for (let row = startRow; row <= 600; row += 1) {
    const topValue = readCellText(sheet, `A${row}`);
    const importedTitle = readCellText(sheet, `B${row}`);
    const dayCell = getCellValue(sheet, row, 4);
    // Spalte D enthält bei TOPs den Tag, bei P/U-Zeilen dagegen die Zeilenart.
    const property = typeof dayCell === "string" ? dayCell.trim().toUpperCase() : "";
    const kind: AgendaKind = property === "P" ? "break" : property === "U" ? "heading" : "topic";
    const titleValue = kind === "break" ? importedTitle || "Pause" : importedTitle;

    if (!topValue && !importedTitle && kind !== "break") {
      blankStreak += 1;
      if (blankStreak >= 20 && imported.length > 0) {
        break;
      }
      continue;
    }

    blankStreak = 0;

    if (!titleValue || (kind === "topic" && !topValue)) {
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

    const durationSec =
      kind === "heading"
        ? 0
        : (parseDurationCell(getCellValue(sheet, row, 3)) ?? (kind === "break" ? 5 : 15) * 60);
    if (kind !== "heading" && (durationSec <= 0 || durationSec > maxImportDurationSec)) {
      throw new Error(`Ungültige TOP-Dauer in Zeile ${row}.`);
    }

    const dayLabel = kind === "topic"
      ? parseDayLabel(dayCell, topValue)
      : kind === "heading"
        ? findFollowingDayLabel(sheet, row) ?? imported[imported.length - 1]?.day ?? "Tag 1"
        : imported[imported.length - 1]?.day ?? "Tag 1";

    imported.push({
      id: `import-${row}-${topValue.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      kind,
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
