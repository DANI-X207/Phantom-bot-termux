const status = document.querySelector('#status');
const qrCard = document.querySelector('#qr-card');
const qr = document.querySelector('#qr');
const sessions = document.querySelector('#sessions');
const newSessionCard = document.querySelector('#new-session-card');
const newSessionQr = document.querySelector('#new-session-qr');
const addSessionButton = document.querySelector('#add-session');
const resetButton = document.querySelector('#reset');
let pendingSessionId = null;

async function refresh() {
  try {
    const data = await fetch('/api/status').then(res => res.json());
    status.textContent = ({ qr: 'Scan requis pour la super-session', connected: 'Super-session connectée', loading: 'Démarrage…', disconnected: 'Connexion de la super-session…' })[data.status] || data.status;
    qrCard.hidden = !data.qrImage;
    if (data.qrImage) qr.src = data.qrImage;
    const superConnected = data.status === 'connected';
    addSessionButton.hidden = !superConnected;
    resetButton.hidden = !superConnected;
    const pendingSession = data.sessions.find(session => session.id === pendingSessionId);
    if (pendingSession?.qrImage) {
      newSessionCard.hidden = false;
      newSessionQr.src = pendingSession.qrImage;
    } else if (pendingSession?.status === 'connected' || !pendingSession) {
      newSessionCard.hidden = true;
      if (!pendingSession) pendingSessionId = null;
    }
    sessions.replaceChildren(...data.sessions.map(session => {
      const item = document.createElement('li');
      item.textContent = `${session.super ? '👑' : '🔗'} ${session.number ? '+' + session.number : 'En attente'} — ${session.status}`;
      return item;
    }));
  } catch (_) { status.textContent = 'Serveur inaccessible'; }
}
resetButton.addEventListener('click', async () => {
  if (!confirm('Déconnecter la super-session et générer un nouveau QR ?')) return;
  await fetch('/api/reset', { method: 'POST' });
  refresh();
});
addSessionButton.addEventListener('click', async () => {
  addSessionButton.disabled = true;
  try {
    const response = await fetch('/api/sessions', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Création impossible');
    pendingSessionId = result.id;
    status.textContent = 'Génération du QR de la nouvelle session…';
    await refresh();
  } catch (error) {
    alert(error.message);
  } finally {
    addSessionButton.disabled = false;
  }
});
refresh(); setInterval(refresh, 2000);
