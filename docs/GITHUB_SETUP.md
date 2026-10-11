# GitHub Setup

## 1) Repository initialisieren

```bash
git init
git add .
git commit -m "chore: bootstrap Sitzungsbuddy"
git branch -M main
git remote add origin <DEIN_GITHUB_REPO_URL>
git push -u origin main
```

## 2) Branch-Strategie

- `main`: immer releasefähig
- Feature-Branches: `feat/<thema>`
- Bugfix-Branches: `fix/<thema>`

## 3) Pull Request Regeln

- Mindestens 1 Review
- CI muss grün sein
- Security-Scan ohne kritische Findings

## 4) Automatische Installer-Releases

Der Workflow `.github/workflows/release.yml` baut beim Push eines Tags (`v*`) automatisch macOS- und Windows-Artefakte und legt einen Draft-Release in GitHub an.

### Release auslösen

```bash
git tag v0.1.0
git push origin v0.1.0
```

Alternativ kann der Workflow manuell mit `release_tag` gestartet werden.

### Erwartete Artefakte

- macOS: `.app` und/oder `.dmg`
- Windows: `.exe` (NSIS) und/oder `.msi`

### Empfohlene Secrets für Produktion

- `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`

Ohne Signierung funktionieren Builds technisch, aber macOS/Windows zeigen Warnungen beim Installieren.
