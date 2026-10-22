# Sitzungsbuddy

Desktop-App zur Live-Begleitung komplexer, mehrtägiger Sitzungen auf macOS und Windows.

## Funktionen

- Excel-Agenda mit TOPs, Pausen (`P`) und Überschriften (`U`) importieren
- Sitzung live steuern: OnAir mit Beenden-Dialog, Pause, Vorwärts- und Rückwärts-Triggern
- Plan-/Ist-Zeiten und voraussichtliches Sitzungsende anzeigen
- Zukünftige Zeilen verschieben, als Block auswählen, auf Halt setzen oder bearbeiten
- Reduzierte Beameransicht auf einem externen Monitor anzeigen
- Sitzungsstand lokal sichern und ein AsRun-Log als PDF exportieren

## Tech-Stack

- `Tauri v2`
- `React` + `TypeScript`
- `Vite`

## Voraussetzungen

- Node.js 22+
- Rust Toolchain (für Tauri Desktop-Builds)
- Plattformabhängige Tauri-Prerequisites

## Lokale Entwicklung

```bash
npm install
npm run dev
```

Für Desktop-Entwicklung mit Tauri (nach Rust-Installation):

```bash
npm run tauri dev
```

Hinweis: `tauri dev` räumt Port `1420` automatisch frei.

## Aufbau

- `src/App.tsx`: Oberfläche und Sitzungssteuerung
- `src/lib/agenda.ts`: Agenda-Datenmodell und Planungshelfer
- `src/lib/excelImport.ts`: Excel-Import und Validierung
- `src-tauri/src/lib.rs`: native Tauri-Funktionen

Die Zustandsregeln und weitere Refactoring-Schritte stehen in `docs/ARCHITECTURE_DECISIONS.md`.

## Projekt-Dokumentation

- `docs/AGENT_PLAYBOOK.md`
- `docs/PRODUCT_MVP.md`
- `docs/ARCHITECTURE_DECISIONS.md`
- `docs/SECURITY_BASELINE.md`
- `docs/UX_SPEC.md`
- `docs/GITHUB_SETUP.md`
- `docs/BRANCH_PROTECTION.md`
