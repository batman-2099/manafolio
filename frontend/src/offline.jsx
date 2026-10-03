import React from 'react';
import ReactDOM from 'react-dom/client';
import { I18nProvider } from './utils/i18n.jsx';
import { OFFLINE_EVENT } from './utils/offlineCollection.js';
import OfflineCollection from './components/OfflineCollection.jsx';
import themes from '../../shared/themes.json';
import './index.css';
import './arcane.css';

let theme = 'dark';
try {
  const user = JSON.parse(localStorage.getItem('manafolio_user') || 'null');
  if (localStorage.getItem('manafolio_token') && themes.includes(user?.theme)) theme = user.theme;
} catch { /* The empty state remains usable when browser storage is unavailable. */ }
document.documentElement.setAttribute('data-theme', theme);

window.addEventListener('manafolio_logout', () => {
  localStorage.removeItem('manafolio_token');
  localStorage.removeItem('manafolio_user');
  window.dispatchEvent(new Event(OFFLINE_EVENT));
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nProvider><OfflineCollection /></I18nProvider>
  </React.StrictMode>,
);
