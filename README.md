# Sitzungsbuddy

Desktop-App zur Live-Begleitung komplexer, mehrtägiger Sitzungen auf macOS und Windows.

## MVP-Fokus

- Excel-Agenda importieren
- OnAir-Start für die Live-Sitzung
- Gesamtzeit + Countdown des aktuellen TOP
- `Space` für den nächsten Tagesordnungspunkt
- Zukünftige Punkte umsortieren oder auf Halt setzen
- Beamer-Ansicht (im Scaffold als Preview-Stub)

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

## Projekt-Dokumentation

- `docs/AGENT_PLAYBOOK.md`
- `docs/PRODUCT_MVP.md`
- `docs/ARCHITECTURE_DECISIONS.md`
- `docs/SECURITY_BASELINE.md`
- `docs/UX_SPEC.md`
- `docs/GITHUB_SETUP.md`
- `docs/BRANCH_PROTECTION.md`
