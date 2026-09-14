# Phantom Bot — édition Termux

Cette version est prévue pour un téléphone Android 64 bits avec **Termux installé depuis F-Droid ou GitHub**. Ne pas utiliser l'ancienne édition Google Play, dont les dépôts ne sont plus maintenus.

## Installation

1. Copiez ce dossier dans le répertoire privé de Termux, par exemple `~/Phantom-bot-termux`. Évitez d'exécuter Node.js depuis `~/storage/downloads` : le stockage partagé Android gère mal les permissions et les liens symboliques de `node_modules`.
2. Dans Termux, lancez :

   ```bash
   cd ~/Phantom-bot-termux
   bash install_termux.sh
   ```

3. Lancez le bot :

   ```bash
   ./.termux/run.sh
   ```

Le tableau de bord est accessible sur le téléphone à l'adresse `http://127.0.0.1:3000`. Scannez le QR WhatsApp affiché au premier lancement.

## Pourquoi cette version est différente

- `yt-dlp` est installé depuis les dépôts Termux et utilisé à la place d'un binaire Linux téléchargé par npm.
- FFmpeg est récupéré depuis Termux, sans fichier `ffmpeg.exe` Windows.
- Les stickers utilisent la version WebAssembly de `sharp`, compatible avec Android ARMv7 et ARM64 (elle est un peu moins rapide qu'une version native).

## Garder le bot actif

Le lanceur active `termux-wake-lock` si la commande est disponible. Désactive aussi l'optimisation de batterie pour Termux dans les réglages Android. Pour conserver une session terminal : `tmux new -s phantom`, puis lance le bot.

Après une mise à jour des dépendances, relance `bash install_termux.sh`.
