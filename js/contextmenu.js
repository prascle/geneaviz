/**
 * contextMenu.js — Menu contextuel partagé (clic droit sur un individu).
 *
 * Affiche un menu HTML personnalisé à la position du curseur ; fermeture au
 * clic ailleurs, à la touche Échap, au redimensionnement ou à la perte de
 * focus. Items désactivables (actions à venir) et séparateurs supportés.
 */

/**
 * Initialise le menu contextuel (singleton DOM).
 * @returns {{show: Function, close: Function}}
 */
export function initContextMenu() {
  let menu = document.querySelector('div.ctx-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.className = 'ctx-menu';
    document.body.appendChild(menu);
  }
  menu.style.display = 'none';

  const close = () => { menu.style.display = 'none'; };
  document.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);

  /**
   * Affiche le menu à la position de l'événement.
   * @param {Event} event - événement contextmenu (preventDefault appelé)
   * @param {Array<{label: string, action?: Function, disabled?: boolean,
   *                hint?: string, separator?: boolean}>} items
   */
  function show(event, items) {
    event.preventDefault();
    menu.innerHTML = '';
    for (const it of items) {
      if (it.separator) {
        const sep = document.createElement('div');
        sep.className = 'ctx-separator';
        menu.appendChild(sep);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'ctx-item' + (it.disabled ? ' disabled' : '');
      el.textContent = it.label + (it.hint ? ' ' + it.hint : '');
      if (!it.disabled) {
        el.addEventListener('click', () => { close(); it.action(); });
      }
      menu.appendChild(el);
    }
    menu.style.display = 'block';
    const w = menu.offsetWidth, h = menu.offsetHeight;
    let x = event.clientX + 6, y = event.clientY + 6;
    if (x + w > window.innerWidth - 8) x = event.clientX - w - 6;
    if (y + h > window.innerHeight - 8) y = event.clientY - h - 6;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  return { show, close };
}