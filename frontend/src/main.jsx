import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { I18nProvider } from './utils/i18n.jsx'
import './index.css'
import './arcane.css'

// Demo build (GitHub Pages): install the fixture-backed fetch shim and seed a
// fake session BEFORE first render. Guard is a static env check, so a normal
// build tree-shakes the whole ./demo chunk out.
if (import.meta.env.VITE_DEMO) {
  await import('./demo/install.js')
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
)
