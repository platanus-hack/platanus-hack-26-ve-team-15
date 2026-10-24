// URL del backend por defecto: tu PC cuando el panel se abre en localhost y el backend de Render en cualquier
// otro caso. Se puede cambiar con ?api=https://… en la URL o desde "Ajustes" en el panel (queda en localStorage).
const runsLocally = ['localhost', '127.0.0.1'].includes(window.location.hostname);

window.BALIZA_CONFIG = {
  api: runsLocally ? 'http://localhost:8080' : 'https://baliza-vital-backend.onrender.com',
};
