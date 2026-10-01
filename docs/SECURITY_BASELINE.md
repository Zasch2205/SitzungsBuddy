# Security Baseline

## Threat Model (MVP)

- Manipulierte oder fehlerhafte Excel-Dateien
- Abstürze mit Datenverlust während Live-Sitzung
- Unsichere Drittanbieter-Abhängigkeiten
- Unsichere Update-/Release-Artefakte

## Mindestmaßnahmen

1. **Input-Validierung**
   - Nur erlaubte Dateitypen (`.xlsx`, optional `.xls`)
   - Strikte Schema-Prüfung für Importspalten
   - Größen- und Werte-Grenzen (z. B. Dauer > 0)
2. **Sichere Defaults**
   - Keine Ausführung eingebetteter Office-Inhalte
   - Beamer-Ansicht ohne interne Metadaten
3. **Dependency Hygiene**
   - Lockfile verpflichtend
   - Vulnerability-Scan in CI
4. **Release-Sicherheit**
   - Signierte Builds für macOS und Windows
   - Reproduzierbarer Build-Prozess über CI

