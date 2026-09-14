#!/data/data/com.termux/files/usr/bin/bash
# Installation reproductible de Phantom Bot pour Termux (Android 64 bits).
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$PROJECT_DIR"

if [ "${PREFIX:-}" != "/data/data/com.termux/files/usr" ]; then
    echo "Erreur : ce script doit être lancé depuis Termux officiel (F-Droid ou GitHub)."
    exit 1
fi

echo "[1/4] Mise à jour des dépôts Termux…"
pkg update -y

echo "[2/4] Installation des paquets système…"
# libvips + outils de compilation permettent à sharp (stickers) d'être compilé
# pour Android au lieu de télécharger un binaire Linux incompatible.
pkg install -y nodejs-lts npm python python-yt-dlp ffmpeg git tmux clang make pkg-config libvips glib xorgproto

if ! command -v node >/dev/null || ! command -v npm >/dev/null || ! command -v yt-dlp >/dev/null || ! command -v ffmpeg >/dev/null; then
    echo "Erreur : Node.js, npm, yt-dlp ou FFmpeg est indisponible après installation."
    exit 1
fi

echo "[3/4] Installation des modules Node.js pour Android…"
# Ne jamais réutiliser node_modules depuis Windows/Linux : sharp contient du code natif.
rm -rf node_modules
export npm_config_nodedir="$PREFIX"
export npm_config_build_from_source=true
export YOUTUBE_DL_SKIP_DOWNLOAD=1
export YOUTUBE_DL_DIR="$PREFIX/bin"
npm ci --omit=dev

echo "[4/4] Vérification des composants…"
node -e "require('@whiskeysockets/baileys'); require('wa-sticker-formatter'); console.log('Modules Node.js : OK')"
yt-dlp --version >/dev/null
ffmpeg -version >/dev/null

chmod +x .termux/run.sh
echo
echo "Installation terminée. Démarrage : ./.termux/run.sh"
echo "Le premier lancement affichera le QR WhatsApp."
