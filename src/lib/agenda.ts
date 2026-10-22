export type AgendaState = "planned" | "live" | "hold" | "done" | "skipped";
export type AgendaKind = "topic" | "break" | "heading" | "placeholder";

export type AgendaItem = {
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

export function isPlayableAgendaItem(item: AgendaItem): boolean {
  return item.kind === "topic" || item.kind === "break";
}

export function normalizeOrder(items: AgendaItem[]): AgendaItem[] {
  return items.map((item, index) => ({ ...item, order: index + 1 }));
}

export function hasSameAgendaBlueprint(left: AgendaItem[], right: AgendaItem[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  // Laufzeitwerte bleiben außen vor: Hier zählt nur, ob sich das Agenda-Grundgerüst geändert hat.
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

export function sanitizeImportedText(rawValue: string, maxLength = 240): string {
  // Steuerzeichen und Richtungswechsel dürfen importierte Beschriftungen nicht verfälschen.
  return rawValue
    .replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
