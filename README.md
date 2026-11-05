# Reference Board

A reference board for artists that runs in Chrome. Think PureRef, but with
Blender-style split views: one shared infinite canvas, seen through several
panes, each with its own pan and zoom.

## Try it

Open the GitHub Pages link for this repository in Chrome. There is nothing to install.

## Controls

| Action | How |
| --- | --- |
| Add images | Drag files in from your computer, drag images in from another tab, or paste (Ctrl/⌘ + V) |
| Zoom | Scroll wheel, or pinch on a trackpad. Zooms the pane under the mouse, towards the mouse |
| Pan | Drag empty space, middle-mouse drag, or hold Space and drag |
| Move an image | Drag it (it also comes to the front). Every pane updates |
| Fit to pane | `F` fits the selected image, or everything when nothing is selected |
| Actual size | `1` sets the zoom to 100% |
| Delete | `Delete` or `Backspace` |
| Menu | Right-click anywhere, or click the board name in the top-left corner |

### Split view

Hover over a pane to see its buttons in the top-right corner.

| Action | How |
| --- | --- |
| Split side by side | Pane button, or `Alt` + `V` |
| Split top and bottom | Pane button, or `Alt` + `H` |
| Maximize / restore a pane | Pane button, or `Ctrl` + `Space` (or the `` ` `` key) |
| Close a pane | Pane button, or `Alt` + `W` |
| Resize panes | Drag the line between them. Double-click it to make both sides equal |

Keyboard shortcuts act on the pane under the mouse.

### Saving

- **Autosave:** Chrome keeps your current board, so closing the tab doesn't lose anything. This copy only lives in Chrome on this computer.
- **Save / Save as** (Ctrl/⌘ + S, Ctrl/⌘ + Shift + S) creates a `.refboard` file with all images and the pane layout inside it.
- **Open** (Ctrl/⌘ + O), or drop a `.refboard` file onto the page.
- To share a board, send the `.refboard` file. The other person opens this website and drops it in, with nothing to install.
- A dot next to the board name means there are changes not yet saved to a file.

A `.refboard` file is a normal zip file, so you can also unzip it to get the images back.

Some websites block other pages from loading their images. If dragging one in
doesn't work, right-click it, choose **Copy Image**, and paste it instead.

## Roadmap

1. ✅ Canvas with drag-and-drop images, pan and zoom
2. ✅ Split viewports sharing the same canvas
3. ✅ Saving and loading (board files + autosave)
4. Drawing and notes
5. Image search (Unsplash, Pexels, Openverse)

## How the code is organised

There's no build step: the files are served as they are.

- `index.html`, `style.css`: the page and its look
- `src/main.js`: starts the app and connects the mouse, keyboard, menu, drop and paste
- `src/board.js`: the shared canvas and the images on it
- `src/camera.js`: one view onto the board (pan and zoom)
- `src/layout.js`: how the window is split into panes
- `src/viewports.js`: draws the board into every pane; pane buttons and dividers
- `src/storage.js`: board files (.refboard) and autosave
- `src/menu.js`: the right-click menu
- `src/importer.js`: getting images in from files, other tabs and the clipboard
- `vendor/pixi.min.mjs`: [PixiJS](https://pixijs.com) 8.22, the fast WebGL renderer
- `vendor/fflate.mjs`: [fflate](https://github.com/101arrowz/fflate) 0.8.2, for zipping board files

To run it on your own computer, serve the folder with any local web server, for example
`python3 -m http.server`, then open http://localhost:8000.
