// Tools a pane can show instead of the board. Each tool is created inside the
// pane's HTML box and has: layout(rect) when the pane changes size (optional),
// focus() (optional), and destroy().

import { SearchPane } from './search-pane.js';

// actions: shared helpers from main.js (adding images to the board, saving, messages).
export function createEditor(pane, host, actions) {
  if (pane.type === 'search') return new SearchPane(pane, host, actions);
  if (pane.type === 'mannequin') {
    // Loaded only when first used, so the 3D engine doesn't slow down opening the app.
    const holder = { type: 'mannequin', destroyed: false, editor: null, rect: null };
    host.innerHTML = '<div class="pane-loading">Loading the mannequin…</div>';
    import('./mannequin-pane.js').then(({ MannequinPane }) => {
      if (holder.destroyed) return;
      host.replaceChildren();
      holder.editor = new MannequinPane(pane, host, actions);
      if (holder.rect) holder.editor.layout(holder.rect);
    }).catch((err) => {
      console.error(err);
      host.innerHTML = '<div class="pane-loading">The mannequin couldn\'t load. Refresh the page to try again.</div>';
    });
    holder.layout = (rect) => { holder.rect = rect; holder.editor?.layout(rect); };
    holder.focus = () => holder.editor?.focus?.();
    holder.destroy = () => { holder.destroyed = true; holder.editor?.destroy(); };
    return holder;
  }
  return null;
}
