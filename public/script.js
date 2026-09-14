const status = document.querySelector('#status');
const qrCard = document.querySelector('#qr-card');
const qr = document.querySelector('#qr');
const sessions = document.querySelector('#sessions');

async function refresh() {
  try {
    const data = await fetch('/api/status').then(res => res.json());
    status.textContent = ({ qr: 'Scan requis', connected: 'Super-session connectée', loading: 'Démarrage…', disconnected: 'Déconnectée' })[data.status] || data.status;
    qrCard.hidden = !data.qrImage;
    if (data.qrImage) qr.src = data.qrImage;
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
refresh(); setInterval(refresh, 2000);
