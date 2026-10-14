/**
 * contextMenu.js — Menu contextuel partagé (clic droit sur un individu).
 *
 * Affiche un menu HTML personnalisé à la position du curseur ; fermeture au
 * clic ailleurs, à la touche Échap, au redimensionnement ou à la perte de
 * focus. Items désactivables, séparateurs et mini-éditeurs numériques
 * (M6b : choix du nombre de générations) supportés.
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
    (document.getElementById('workspace') ?? document.body).appendChild(menu);
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
   *                hint?: string, separator?: boolean,
   *                editor?: {label: string, min: number, max: number,
   *                          def: number, onValidate: Function}}>} items
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
      if (it.editor) {
        const ed = it.editor;
        const row = document.createElement('div');
        row.className = 'ctx-editor';
        const lbl = document.createElement('span');
        lbl.textContent = ed.label;
        const input = document.createElement('input');
        input.type = 'number';
        input.min = String(ed.min); input.max = String(ed.max);
        input.value = String(ed.def);
        const ok = document.createElement('button');
        ok.type = 'button'; ok.textContent = '✓'; ok.title = 'Valider';
        row.append(lbl, input, ok);
        // les clics dans l'éditeur ne ferment pas le menu
        row.addEventListener('click', (ev) => ev.stopPropagation());
        ok.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const n = Math.max(ed.min, Math.min(ed.max, Number(input.value) || ed.def));
          close();
          ed.onValidate(n);
        });
        menu.appendChild(row);
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