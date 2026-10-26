// Applies the saved colour theme before first paint to avoid a light/dark flash.
try {
  const saved = localStorage.getItem('autorush-theme')
  document.documentElement.dataset.theme = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
} catch { /* storage unavailable */ }
