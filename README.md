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
| Select several | Shift-click to add or remove one, or Shift-drag a box on empty space. Ctrl/⌘ + A selects everything |
| Scale / rotate | Drag a corner handle to scale, or the round handle above to rotate (hold Shift to snap to 15°) |
| Flip, crop, greyscale, colours, arrange, lock, delete | The small bar above the selection, or right-click. **Crop**: drag a box over the part to keep. **Extract colours** adds a palette of the image's main colours, with their codes and how much of each. **Arrange** puts the selection in tidy rows |
| Fit to pane | `F` fits the selected image, or everything when nothing is selected |
| Actual size | `1` sets the zoom to 100% |
| Delete | `Delete` or `Backspace` |
| Lock / unlock | Right-click an image or note, or press `L` with it selected. **Lock everything** / **Unlock everything** are in the same menu. Locked things can't be selected, moved or erased |
| Menu | Right-click anywhere, or click the board name in the top-left corner |

### What a pane shows

The first button in a pane's corner chooses what the pane shows:

- **Board:** your references.
- **Image search:** search for images and drag them onto the board, or click one to add it.
- **3D mannequin:** a posable wooden figure to use as a pose and lighting reference.

Splitting a pane copies what it shows. Press **Ctrl/⌘ + F** to open a search pane next to
the one you're working in, or to jump to it if one is already open.

### Image search

The search pane has two tabs: **Search** and **Mood board**.

**Search** looks in every source at once and mixes the results into one feed:

| Needs no key | Needs a free key (**Sources** button) |
| --- | --- |
| Openverse, Wikimedia Commons, Art Institute of Chicago, Cleveland Museum of Art, iNaturalist (animals and plants), NASA | Unsplash, Pexels, Pixabay, Flickr |

Keys are kept in this browser only. Each source can be switched off in **Sources**.

- **All / Photos / Art / Nature** narrows the feed to one kind of source.
- The feed is ranked a bit like Pinterest: how relevant each source thinks a result is, how big and sharp it is, whether its words match your search, and what you've added to boards before (remembered in this browser only). Duplicates and tiny pictures are dropped, off-topic museum results sink, and no source takes over the feed.
- **Chips** next to the filter suggest words that narrow the search.
- Hover over a result for **Add to board** and **More like this**. You can also click a result, or drag it onto a board pane. Added images go to the nearest empty spot in the middle of your view, so they never pile up on top of each other.

**Mood board** makes a ready-made mood board from a description. Separate ideas with
commas to mix them (*"foggy forest, lanterns, old wooden house"*): each idea gets its
share of the images. Choose how many, remove any you don't like with ×, press **Shuffle**
for a different mix, then **Add to board**. They're laid out in columns next to what's
already on the board, and Ctrl/⌘ + Z removes the whole set.

Each image keeps a link to its original page and author. Check the licence before
using an image in published work. Some sites block full-size downloads; a smaller
version is added instead.

Google Images isn't included: Google doesn't offer free image search to other apps,
and its paid service can't be called straight from a web page.

### Text and fonts

Select a text (or sticky note) to get its controls in the bar above it:

- **Level:** Title, Heading 1, 2 and 3, Body, Caption (like Notion). New text starts at the level you last chose.
- **Font:** the board's own fonts are Inter, Space Grotesk, Instrument Serif, Bebas Neue, Bangers and JetBrains Mono. **Upload a font…** adds your own (.ttf, .otf, .woff, .woff2), or drop a font file onto the page. Uploaded fonts are kept for all your boards and travel inside board files, so they look right for whoever opens them.
- **Bold** (Ctrl/⌘ + B), **italic** (Ctrl/⌘ + I), **alignment** and **colour**.
- Corner handles scale text and the round handle rotates it, like images. Double-click to edit.

### 3D mannequin

Choose **3D mannequin** from a pane's type button.

| Action | How |
| --- | --- |
| Move a hand or foot | Drag it. The arm or leg bends to follow, like a puppet |
| Move a figure across the floor | Drag its hips |
| Fine-tune a joint | Click a body part, then drag the coloured rings. `Esc` deselects |
| Orbit around the scene | Drag empty space |
| Move the view | Right-drag |
| Zoom | Scroll |
| More figures | **+ Figure** adds one (up to 6), **Remove** removes the selected one, and the height menu makes it a child, teen, short, average or tall figure |
| Ready-made poses | The **Poses…** menu: standing, contrapposto, walking, running, sitting, crouching, kneeling, reaching, fighting stance and more |
| Mirror / Reset | Swap left and right / back to standing |
| Light | Move the main light around (**Light**) and up or down (**Height**) to study shadows |
| Lens | 24, 35, 50 or 85 mm, like a camera. Wider lenses exaggerate perspective |
| Add to board | Puts a picture of the current view on the board |

Poses, typed poses, Mirror and Reset act on the figure you last clicked; with several
figures, a blue ring on the floor shows which one. Every figure stays standing on the
floor. All figures, the camera, the light and the lens are saved with the board.

#### Typing a pose

Type a description in the box under the top bar and press **Pose it**, for example
*"kneeling on the left knee, arms crossed, looking up"*. It's free, instant and works
offline. The mannequin moves into the pose, and you can then click any body part to
fine-tune it.

- It recognises about 40 activities (sitting, cross-legged, hugging knees, kneeling, on one knee, crouching, lying on the back / front / side, walking, running, jumping, lunge, kicking, punching, sword swing, drawing a bow, throwing, dancing, sneaking, superhero landing, tree pose, pushing, pulling, carrying…) and many body-part words (arms crossed, hands on hips, hands behind the head, left arm up, waving, pointing, looking left / up / down / over the right shoulder, leaning forward, slouching, weight on the right leg, wide stance, on tiptoe…).
- *Slightly* / *a bit* and *very* / *a lot* change how strong a change is.
- Without an activity word, changes apply to the current pose, so *"now look up"* works.
- Left and right mean the figure's own. *Facing left* means turned toward the left of the screen. *Facing away*, *profile* and *three-quarter view* turn the figure.

**Ask Claude** is optional, for descriptions the free engine doesn't understand. It uses
your own Anthropic API key (key button), which stays in this browser and is only sent to
Anthropic. Each pose is one request to Claude Opus 5.5 and costs a few cents on your
Anthropic account. If Anthropic's safety checks decline a request, it is automatically
retried on another Claude model.

### Drawing and notes

The toolbar sits at the bottom middle of the window. It has the drawing tools, the colour
(click it for the palette, including any colour you like), size, and undo/redo. The **⌄**
button folds it into a small pill; click the pill to bring it back. It fades out while
your mouse is over a search or mannequin pane, so it never covers their buttons.

| Action | How |
| --- | --- |
| Select and move | `V` |
| Hand (move around without touching images) | `H`. Space + drag and the middle mouse button also always pan |
| Pen | `B` (or `P`). Pressure-sensitive with a tablet pen |
| Eraser | `E`, or flip your tablet pen over. Removes whole strokes |
| Text | `T`, then click and type. Start with `# `, `## ` or `### ` for a heading. Click away to finish |
| Sticky note | `N`, then click where the note should go and type. Click away to finish |
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

### Light and dark mode

Switch with the sun / moon button in the top bar or on the home screen, or **Light mode** / **Dark mode** in the board
menu (**⋯**). Boards have a dotted background that stays fixed to the board as you pan and
zoom; the dots double or halve their spacing as you zoom so they never get too dense.

### Your boards

Opening the site shows your boards: click **New board**, or click a board to open it.
On a board, the bar across the top takes you back to your boards (**Boards**), shows the
board's name (click it to rename) and has the board menu (**⋯**). The **⋯** button on a board's card can rename it, save it
to a file, or delete it.

- **Boards save as you work.** They're kept in Chrome on this computer, so closing the tab doesn't lose anything.
- **Save to file** (Ctrl/⌘ + S) creates a `.refboard` file with all images and the pane layout inside it. Use it to back up a board or share it.
- **Open file…** (Ctrl/⌘ + O), or drop a `.refboard` file onto the page. It's added as a new board and never replaces one you have.
- Dropping or pasting images on the home screen starts a new board with them.
- To share a board, send the `.refboard` file. The other person opens this website and drops it in, with nothing to install.

A `.refboard` file is a normal zip file, so you can also unzip it to get the images back.

Some websites block other pages from loading their images. If dragging one in
doesn't work, right-click it, choose **Copy Image**, and paste it instead.

## Browser extension

Send any image from any website to a board with one click, or capture part of a page,
without downloading anything first.

**Install (once, about a minute):**

1. Download [reference-board-extension.zip](https://germanreinac.github.io/reference-board/reference-board-extension.zip) and unzip it.
2. In Chrome, go to `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped `reference-board-extension` folder.
4. Optional: click the puzzle-piece icon in Chrome's toolbar and pin **Reference Board**.

(It isn't on the Chrome Web Store, which costs a fee and needs a review, so it's installed from the folder.
Chrome may remind you that a developer-mode extension is on; that's expected.)

**Use it:**

- **Right-click any image → Send image to Reference Board.** It works even on sites that block downloads.
- **Capture part of a page:** the extension's button → **Capture part of this page**, the right-click menu, or **Alt+Shift+S**. Drag a box; Esc cancels.
- The image lands on the board you have open. If Reference Board isn't open, it opens it and puts the image in a board called **Inbox**.
- To capture **other apps** (a game, a film, a video call), use **Capture screen…** in the board menu (**⋯**). Chrome asks which window or screen to share.

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
- `src/search-pane.js`: the image search pane
- `src/search-engine.js`: mixing and ranking results from every source
- `src/sources.js`: the image sources (Openverse, Unsplash, Pexels)
- `src/mannequin.js`: the 3D figure, its joints and the ready-made poses
- `src/mannequin-pane.js`: the mannequin pane (3D view, posing, light, lens)
- `src/pose-words.js`: free typed poses (turns words into a pose, in the browser)
- `src/ai-pose.js`: optional typed poses with Claude
- `src/tools.js`: the drawing toolbar and brush outline
- `src/note-editor.js`: typing into notes
- `src/history.js`: undo and redo
- `src/importer.js`: getting images in from files, other tabs and the clipboard
- `vendor/pixi.min.mjs`: [PixiJS](https://pixijs.com) 8.22, the fast WebGL renderer
- `vendor/perfect-freehand.mjs`: [perfect-freehand](https://github.com/steveruizok/perfect-freehand) 1.2.2, for natural-looking pen strokes
- `extension/`: the Chrome extension (also packed as `reference-board-extension.zip`)
- `src/fonts.js`: the board's fonts and your uploaded fonts
- `vendor/fonts/`: the built-in fonts (SIL Open Font License)
- `vendor/three/`: [Three.js](https://threejs.org) 0.170, for the 3D mannequin (loaded only when a mannequin pane is opened)
- `vendor/anthropic-sdk.mjs`: the official [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) 1.1.0, bundled into one file with esbuild (loaded only when you type a pose)
- `vendor/fflate.mjs`: [fflate](https://github.com/101arrowz/fflate) 0.8.2, for zipping board files

To run it on your own computer, serve the folder with any local web server, for example
`python3 -m http.server`, then open http://localhost:8000.

## Updating the site

Before publishing changes, run `python3 tools/stamp-version.py`. It gives every code file a
new version number in `index.html`, so browsers load the new files together instead of
mixing in old copies they've kept. The version shows at the bottom of the home screen.
