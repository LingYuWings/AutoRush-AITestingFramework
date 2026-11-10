import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import { uiLanguage } from './shared/i18n.ts'
import './style.css'
import './pages.css'

document.documentElement.lang = uiLanguage

// Mount the console under React Strict Mode.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
