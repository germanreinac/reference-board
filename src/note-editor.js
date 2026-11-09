// Typing into a note. While you edit, a real text box sits exactly on top of the
// note in the pane you're working in. When you click away (or press Escape), the
// text goes back onto the board.

export class NoteEditor {
  // onDone(note, newText, oldText) is called when editing ends.
  constructor(onDone) {
    this.onDone = onDone;
    this.note = null;
    this.pane = null;
    this.el = document.createElement('textarea');
    this.el.className = 'note-editor';
    this.el.spellcheck = false;
    this.el.addEventListener('input', () => this.fit());
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();  // typing shouldn't trigger board shortcuts
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) this.el.blur();
    });
    this.el.addEventListener('blur', () => this.finish());
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('wheel', (e) => e.stopPropagation());
    document.body.appendChild(this.el);
    this.el.style.display = 'none';
  }

  get editing() { return this.note !== null; }

  start(note, pane) {
    if (this.note) this.finish();
    this.note = note;
    this.pane = pane;
    this.oldText = note.text;
    note.sprite.visible = false;  // the text box stands in for it while editing
    this.el.value = note.text;
    this.el.style.display = 'block';
    this.position();
    this.el.focus();
    this.el.setSelectionRange(this.el.value.length, this.el.value.length);
  }

  // Keep the text box on top of the note (called on every redraw, e.g. while zooming).
  position() {
    if (!this.note) return;
    const { note, pane } = this;
    if (!pane.rect) return;
    const text = note.style === 'text';
    const k = pane.camera.zoom * note.sprite.scale.x;  // on-screen pixels per board unit
    const fs = note.fontSize * k;
    const pad = (text ? note.fontSize * 0.12 : note.fontSize * 0.55) * k;
    // Centre the box on the note, turned the same way.
    const cx = pane.rect.x + pane.camera.x + note.sprite.x * pane.camera.zoom;
    const cy = pane.rect.y + pane.camera.y + note.sprite.y * pane.camera.zoom;
    const st = note.label.style;
    Object.assign(this.el.style, {
      left: `${cx - (note.width * k) / 2}px`, top: `${cy - (note.height * k) / 2}px`,
      transform: note.sprite.rotation ? `rotate(${note.sprite.rotation}rad)` : '',
      transformOrigin: `${(note.width * k) / 2}px ${(note.height * k) / 2}px`,
      // The box grows with the text, up to the width the text wraps at.
      maxWidth: `${(note.wrap ? note.fontSize * note.wrap : text ? note.base * 34 : note.fontSize * 16) * k + pad * 2}px`,
      minWidth: `${Math.max(note.width * k, note.fontSize * 2 * k)}px`,
      fontFamily: st.fontFamily, fontWeight: st.fontWeight, fontStyle: st.fontStyle, textAlign: note.align || 'left',
      letterSpacing: `${(st.letterSpacing || 0) * k}px`,
      fontSize: `${fs}px`, lineHeight: `${fs * (text ? 1.2 : 1.3)}px`, padding: `${pad}px`,
      borderRadius: `${note.fontSize * 0.35 * k}px`,
      background: text ? 'transparent' : note.color, color: st.fill,
    });
    this.el.classList.toggle('free-text', text);
    this.fit();
  }

  fit() {
    this.el.style.height = 'auto';
    this.el.style.height = `${this.el.scrollHeight}px`;
  }

  finish() {
    if (!this.note) return;
    const note = this.note;
    this.note = null;
    this.el.style.display = 'none';
    note.sprite.visible = true;
    this.onDone(note, this.el.value.replace(/\s+$/, ''), this.oldText);
  }
}
