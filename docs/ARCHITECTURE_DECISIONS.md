# Architekturentscheidungen

## Komponenten

- `src/App.tsx`: Operator- und Beameroberfläche, Sitzungszustand, Trigger, Persistenz und PDF-Export.
- `src/lib/agenda.ts`: gemeinsames Agenda-Datenmodell, reine Planungshelfer und Textbereinigung.
- `src/lib/excelImport.ts`: Zuordnung und Validierung der eingelesenen Excel-Agenda.
- `src/lib/checksum.ts`: Prüfsumme für lokal gespeicherte Sitzungs-Snapshots.
- `src-tauri/src/lib.rs`: native Fenster-Lebensdauer, PDF-Speichern und Schlafsperre während OnAir.

## Zustandsregeln

- Nur das Operator-Fenster verändert die Sitzung. Die Beameransicht liest lokale Snapshots und zeigt keine Steuerung.
- Eine Agenda-Zeile ist `topic`, `break`, `heading` oder `placeholder`. Überschriften haben keine Dauer und werden beim Triggern übersprungen.
- Zeiten basieren auf Zeitstempeln, nicht auf der Zahl der Timer-Ticks. Pausierte Zeit wird abgezogen.
- Die Prognose verwendet für abgeschlossene Einträge Ist-Dauern und für zukünftige Einträge Plan-Dauern. Die Uhrzeiten zukünftiger TOPs laufen während eines aktuellen TOPs nicht sekündlich mit.
- Nur zukünftige geplante oder gehaltene Zeilen dürfen verschoben werden; eine Mehrfachauswahl ist immer ein zusammenhängender Block.
- Sitzungs-Snapshots enthalten eine Prüfsumme gegen beschädigte lokale Daten. Sie ist kein Authentizitätsnachweis.

## Nächste sinnvolle Schritte

- Die Session-Engine und ihre Zustandsübergänge aus `App.tsx` in testbare Funktionen auslagern; anschließend gezielte Tests für Triggern, Pause, Rückwärts-Triggern und Prognose ergänzen.
- Operator-, Beamer- und Dialogoberflächen in kleinere React-Komponenten trennen, ohne die eine schreibende Zustandsquelle aufzugeben.
- Die Agenda-Liste vom 250-ms-Uhrtick entkoppeln: Derzeit rendert `App.tsx` damit auch lange Listen viermal pro Sekunde neu.
- Die Beamer-Synchronisierung mittelfristig von `localStorage`-Polling auf gezielte Ereignisse umstellen; das Polling bleibt vorerst als robuste Rückfallebene bestehen.
- Den Windows-Sleep-Blocker auf realer Hardware prüfen: `SetThreadExecutionState` wirkt pro Thread und muss beim Deaktivieren auf demselben Thread zurückgesetzt werden.

