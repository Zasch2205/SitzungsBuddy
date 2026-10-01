# Produktdefinition MVP

## Primärer Nutzen

Sitzungsbuddy begleitet Live-Meetings mit Zeitsteuerung, klarer Operator-Bedienung und öffentlicher Beamer-Ansicht.

## Muss-Anforderungen (MVP)

1. Excel-Agenda importieren (mehrtägig).
2. Agenda-Einträge: TOP-Nummer, Titel, geplante Dauer, Sitzungstag.
3. `OnAir`-Schalter startet die Live-Session.
4. Anzeige:
   - Laufende Gesamtzeit seit OnAir
   - Countdown für aktuellen Punkt
5. `Space` springt auf den nächsten aktiven Punkt.
6. Zukünftige Punkte:
   - per Reorder umsortierbar
   - auf `Halt` setzbar (überspringbar)
7. Beamer-Modus als separates Fenster.

## Nicht-Ziele (MVP)

- Mehrbenutzer-Synchronisierung in Echtzeit
- Cloud-Konten / Login
- Externe Automations-Integrationen

## Kernzustände eines Agenda-Punkts

- `Planned`
- `Live`
- `Hold`
- `Done`
- `Skipped` (optional für klare Historie)

