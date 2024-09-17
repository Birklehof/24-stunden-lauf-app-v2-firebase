# 24-Stunden-Lauf App v2 Firebase Backend

## Setup

- Installiere die (Firebase CLI)[https://firebase.google.com/docs/cli]
- `npm i` - Installiert alle Abhängigkeiten (**Wichtig! Diesen Befehl im `functions`-Ordner ausführen!**)

## Deployment

- `firebase deploy --only functions`: Deployt die Firebase-Funktionen (**Wichtig! Diesen Befehl im `functions`-Ordner ausführen!**)
- `firebase deploy --only firestore`: Deployt die Firestore Rules + Konfiguartion
- `firebase deploy --only remoteconfig`: Deployt die Firebase Remote Config

oder

- `firebase deploy`: Deployt alles
