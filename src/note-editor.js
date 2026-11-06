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
    const z = pane.camera.zoom;
    const fs = note.fontSize * z;
    const pad = note.fontSize * 0.55 * z;
    const left = pane.rect.x + pane.camera.x + (note.sprite.x - note.width / 2) * z;
    const top = pane.rect.y + pane.camera.y + (note.sprite.y - note.height / 2) * z;
    const textColour = note.label.style.fill;
    Object.assign(this.el.style, {
      left: `${left}px`, top: `${top}px`,
      // The box grows with the text, up to the same width a note wraps at.
      maxWidth: `${note.fontSize * 16 * z + pad * 2}px`,
      minWidth: `${note.fontSize * 2 * z}px`,
      fontSize: `${fs}px`, lineHeight: `${fs * 1.3}px`, padding: `${pad}px`,
      borderRadius: `${note.fontSize * 0.35 * z}px`,
      background: note.color, color: textColour,
    });
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
