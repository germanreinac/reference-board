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

### What a pane shows

The first button in a pane's corner chooses what the pane shows:

- **Board:** your references.
- **Image search:** search for images and drag them onto the board, or click one to add it.
- **3D mannequin:** a posable wooden figure to use as a pose and lighting reference.

Splitting a pane copies what it shows. Press **Ctrl/⌘ + F** to open a search pane next to
the one you're working in, or to jump to it if one is already open.

### Image search

- **Openverse** works straight away. It searches openly licensed images from Flickr, Wikimedia Commons, museums and more.
- **Unsplash** and **Pexels** need a free key. Click the gear in the search pane and paste it in. Keys are kept in this browser only. Get them at [unsplash.com/developers](https://unsplash.com/developers) and [pexels.com/api](https://www.pexels.com/api/).
- Each image keeps a link to its original page (and the photographer's name), so you can always find where it came from. Check the licence before using an image in published work.
- Some sites block full-size downloads. When that happens, a smaller version is added instead.

### 3D mannequin

Choose **3D mannequin** from a pane's type button.

| Action | How |
| --- | --- |
| Orbit around the figure | Drag |
| Move the view | Right-drag |
| Zoom | Scroll |
| Pose a joint | Click a body part, then drag the coloured rings. `Esc` deselects |
| Ready-made poses | The **Poses…** menu: standing, contrapposto, walking, running, sitting, crouching, kneeling, reaching, fighting stance and more |
| Mirror / Reset | Swap left and right / back to standing |
| Light | Move the main light around (**Light**) and up or down (**Height**) to study shadows |
| Lens | 24, 35, 50 or 85 mm, like a camera. Wider lenses exaggerate perspective |
| Add to board | Puts a picture of the current view on the board |

The figure always stays standing on the floor. Its pose, the camera, the light and
the lens are saved with the board.

#### Typing a pose

Type a description in the box under the top bar, for example *"sitting on the floor
hugging her knees, looking left"*, and press **Pose it**. Claude works out the joint
angles and the mannequin moves into the pose. You can then click any body part to
fine-tune it. Small changes work too: *"now look over the right shoulder"* or
*"raise the left arm higher"* start from the current pose.

- It needs your own Anthropic API key. Click the key button next to **Pose it** and paste it in. The key is kept only in this browser and is only sent to Anthropic.
- Each pose is one request to Claude Opus 5.5 and costs a few cents on your Anthropic account.
- If Anthropic's safety checks decline a request, it is automatically retried on another Claude model (Anthropic's "fallbacks" feature).

### Drawing and notes

The toolbar at the bottom of a board has the drawing tools, colours, size, and undo/redo.

| Action | How |
| --- | --- |
| Select and move | `V` |
| Pen | `B` (or `P`). Pressure-sensitive with a tablet pen |
| Eraser | `E`, or flip your tablet pen over. Removes whole strokes |
| Note | `T`, then click where the note should go and type. Click away to finish |
| Edit a note | Double-click it |
| Brush size | `[` and `]`, or the slider |
| Undo / redo | Ctrl/⌘ + `Z` / Ctrl/⌘ + Shift + `Z` |

Strokes and notes are part of the board, so every pane shows them. Strokes are
saved as shapes rather than pixels, so they stay sharp at any zoom. Notes take
the selected colour.

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

### Your boards

Opening the site shows your boards: click **New board**, or click a board to open it.
The button in the top-left corner of a board takes you back, and you can rename a board
by clicking its name there. The **⋯** button on a board's card can rename it, save it
to a file, or delete it.

- **Boards save as you work.** They're kept in Chrome on this computer, so closing the tab doesn't lose anything.
- **Save to file** (Ctrl/⌘ + S) creates a `.refboard` file with all images and the pane layout inside it. Use it to back up a board or share it.
- **Open file…** (Ctrl/⌘ + O), or drop a `.refboard` file onto the page. It's added as a new board and never replaces one you have.
- Dropping or pasting images on the home screen starts a new board with them.
- To share a board, send the `.refboard` file. The other person opens this website and drops it in, with nothing to install.

A `.refboard` file is a normal zip file, so you can also unzip it to get the images back.

Some websites block other pages from loading their images. If dragging one in
doesn't work, right-click it, choose **Copy Image**, and paste it instead.

## Roadmap

- ✅ Canvas with drag-and-drop images, pan and zoom
- ✅ Split viewports sharing the same canvas
- ✅ Board files and saving as you work
- ✅ Home screen with multiple boards
- ✅ Drawing and notes
- ✅ Pane types: each pane can show the board, image search or a 3D mannequin
- ✅ Image search (Openverse, Unsplash, Pexels)
- ✅ 3D posing mannequin with preset poses
- ✅ Typing a pose with AI

## How the code is organised

There's no build step: the files are served as they are.

- `index.html`, `style.css`: the page and its look
- `src/main.js`: starts the app, switches between the home screen and boards, and connects the mouse, keyboard, menu, drop and paste
- `src/home.js`: the home screen with your boards
- `src/board.js`: the shared canvas and the images on it
- `src/camera.js`: one view onto the board (pan and zoom)
- `src/layout.js`: how the window is split into panes
- `src/viewports.js`: draws the board into every pane; pane buttons and dividers
- `src/storage.js`: board files (.refboard) and your boards in Chrome's storage
- `src/menu.js`: the right-click menu
- `src/editors.js`: the tools a pane can show instead of the board
- `src/search-pane.js`, `src/sources.js`: image search and its sources
- `src/mannequin.js`: the 3D figure, its joints and the ready-made poses
- `src/mannequin-pane.js`: the mannequin pane (3D view, posing, light, lens)
- `src/ai-pose.js`: typing a pose (asks Claude for joint angles)
- `src/tools.js`: the drawing toolbar and brush outline
- `src/note-editor.js`: typing into notes
- `src/history.js`: undo and redo
- `src/importer.js`: getting images in from files, other tabs and the clipboard
- `vendor/pixi.min.mjs`: [PixiJS](https://pixijs.com) 8.22, the fast WebGL renderer
- `vendor/perfect-freehand.mjs`: [perfect-freehand](https://github.com/steveruizok/perfect-freehand) 1.2.2, for natural-looking pen strokes
- `vendor/three/`: [Three.js](https://threejs.org) 0.170, for the 3D mannequin (loaded only when a mannequin pane is opened)
- `vendor/anthropic-sdk.mjs`: the official [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) 1.1.0, bundled into one file with esbuild (loaded only when you type a pose)
- `vendor/fflate.mjs`: [fflate](https://github.com/101arrowz/fflate) 0.8.2, for zipping board files

To run it on your own computer, serve the folder with any local web server, for example
`python3 -m http.server`, then open http://localhost:8000.
