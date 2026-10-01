# Branch Protection für `main`

Empfohlene Einstellungen für `Zasch2205/SitzungsBuddy`.

## Ziel

- Kein Direkt-Push auf `main`
- Merge nur über Pull Request
- Mindestens ein Review
- CI muss vor Merge erfolgreich sein

## Einstellungen (GitHub Ruleset oder Branch Protection)

### Branch Target

- Branch Name Pattern: `main`

### Pull Requests

- Require a pull request before merging: **On**
- Required approvals: **1**
- Dismiss stale pull request approvals when new commits are pushed: **On**
- Require review from Code Owners: **On**
- Require conversation resolution before merging: **On**

### Status Checks

- Require status checks to pass before merging: **On**
- Require branches to be up to date before merging: **On**
- Required check: `CI / baseline`

### Branch Safety

- Block force pushes: **On**
- Block branch deletions: **On**

### Admin Scope

- Apply rules to administrators: **On** (empfohlen)

## Warum `CI / baseline`?

Der Workflow in `.github/workflows/ci.yml` hat den Jobnamen `baseline`. In GitHub erscheint der Check als `CI / baseline`.

## Nach der Aktivierung prüfen

1. Test-Branch erstellen und PR öffnen.
2. Sicherstellen, dass ohne grünen CI-Check kein Merge möglich ist.
3. Sicherstellen, dass Direkt-Push auf `main` blockiert ist.

