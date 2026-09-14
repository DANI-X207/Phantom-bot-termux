const status = document.querySelector('#status');
const qrCard = document.querySelector('#qr-card');
const qr = document.querySelector('#qr');
const sessions = document.querySelector('#sessions');
const newSessionCard = document.querySelector('#new-session-card');
const newSessionQr = document.querySelector('#new-session-qr');
let pendingSessionId = null;

async function refresh() {
  try {
    const data = await fetch('/api/status').then(res => res.json());
    status.textContent = ({ qr: 'Scan requis', connected: 'Super-session connectée', loading: 'Démarrage…', disconnected: 'Déconnectée' })[data.status] || data.status;
    qrCard.hidden = !data.qrImage;
    if (data.qrImage) qr.src = data.qrImage;
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
document.querySelector('#reset').addEventListener('click', async () => {
  if (!confirm('Déconnecter la super-session et générer un nouveau QR ?')) return;
  await fetch('/api/reset', { method: 'POST' });
  refresh();
});
document.querySelector('#add-session').addEventListener('click', async () => {
  const button = document.querySelector('#add-session');
  button.disabled = true;
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
    button.disabled = false;
  }
});
refresh(); setInterval(refresh, 2000);
