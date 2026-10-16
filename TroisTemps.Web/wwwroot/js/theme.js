// Thème clair / sombre : appliqué avant l'affichage pour éviter un flash, mémorisé dans le navigateur.
(function () {
  const KEY = 'troistemps-theme';
  const root = document.documentElement;
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* stockage indisponible */ }
  if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;

  const current = () => root.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  window.toggleTheme = () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch { /* ignoré */ }
    document.dispatchEvent(new Event('themechange'));
    return next;
  };
  window.currentTheme = current;
})();
