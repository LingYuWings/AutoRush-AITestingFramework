import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import './style.css'
import './pages.css'

// Mount the console under React Strict Mode.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
