# Architekturentscheidungen (Startpunkt)

## Zielplattform

- Desktop-App für macOS und Windows
- Empfehlung: **Tauri + React + TypeScript**

## High-Level Komponenten

1. **Import-Modul**: Excel lesen, Schema validieren, Mapping auf internes Modell.
2. **Session Engine**: OnAir, Gesamtzeit, Countdown, State-Machine.
3. **Operator UI**: Steuerung, Liste, Status, Hotkeys.
4. **Beamer UI**: read-only Live-Ansicht mit reduzierten Informationen.
5. **Persistenz**: lokale Session- und Agenda-Daten inkl. Recovery.

## Datenmodell (Minimal)

`AgendaItem`
- `id: string`
- `day: string`
- `order: number`
- `top: string`
- `title: string`
- `plannedDurationSec: number`
- `state: Planned | Live | Hold | Done | Skipped`

`SessionState`
- `onAir: boolean`
- `onAirStartedAt: string | null`
- `currentItemId: string | null`
- `elapsedTotalSec: number`

