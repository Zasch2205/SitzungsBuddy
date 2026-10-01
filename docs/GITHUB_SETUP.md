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

