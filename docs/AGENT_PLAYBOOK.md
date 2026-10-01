# Sitzungsbuddy Agent Playbook

Dieses Playbook definiert Reihenfolge, Rollen, Übergaben und Qualitätskriterien für agentische Entwicklung.

## 1) Reihenfolge (verbindlich)

1. **Orchestrator** erstellt Scope, Backlog und Prioritäten.
2. **Software-Architekt** definiert Struktur, Datenmodell, State-Machine, Schnittstellen.
3. **UX-Agent** liefert Nutzerfluss, Hotkeys und Beamer-Ansicht.
4. **Security-Agent** ergänzt Threat Model und Sicherheitsanforderungen.
5. **Implementierungs-Agent(en)** bauen Features in vertikalen Scheiben.
6. **QA-Agent** validiert Verhalten, Timing und Edge Cases.
7. **Release/DevOps-Agent** baut/signiert und veröffentlicht Releases.

## 2) Delivery-Modell

- Entwicklung in **vertical slices** mit End-to-End Nutzwert.
- Jede Aufgabe enthält: Kontext, Akzeptanzkriterien, Testkriterien und Definition of Done.

### Empfohlene Slices

1. Excel-Import + Agenda-Liste
2. OnAir + Gesamtzeit + Countdown
3. Space/Next + Reorder + Halt
4. Beamer-Fenster
5. Persistenz + Crash-Recovery

## 3) Handover-Regeln

- Keine Übergabe ohne klare Artefakte (Dokument, PR, Testnachweis).
- Jeder Agent liefert: erledigt, offen, Risiken, nächster konkreter Schritt.

## 4) PR-Gates

Ein PR wird nur gemerged, wenn:

- Akzeptanzkriterien erfüllt sind
- Tests grün sind (mind. betroffene Ebene)
- Security-Checks für neue Risiken erfolgt sind
- UX-Inkonsistenzen dokumentiert oder behoben sind
- Release Notes ergänzt wurden (bei user-sichtbaren Änderungen)

## 5) Rollenverantwortung (Kurzfassung)

- **Orchestrator:** Priorisierung, Scope-Schutz, Abnahme.
- **Architekt:** technische Konsistenz.
- **UX:** Bedienbarkeit und visuelle Klarheit.
- **Security:** Angriffsflächen, sichere Defaults.
- **Implementation:** feature-korrekte Umsetzung.
- **QA:** reproduzierbare Qualität.
- **Release/DevOps:** reproduzierbarer Build/Release-Prozess.

