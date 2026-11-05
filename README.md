# Reference Board

A reference board for artists that runs in Chrome. Think PureRef, but with
Blender-style split views: one shared infinite canvas, seen through several
panes, each with its own pan and zoom.

## Try it

Open the GitHub Pages link for this repository in Chrome. There is nothing to install.

## Controls (step 1)

| Action | How |
| --- | --- |
| Add images | Drag files in from your computer, drag images in from another tab, or paste (Ctrl/⌘ + V) |
| Zoom | Scroll wheel, or pinch on a trackpad. Zooms towards the mouse |
| Pan | Drag empty space, middle-mouse drag, or hold Space and drag |
| Move an image | Drag it (it also comes to the front) |
| Fit to window | `F` fits the selected image, or everything when nothing is selected |
| Actual size | `1` sets the zoom to 100% |
| Delete | `Delete` or `Backspace` |

Some websites block other pages from loading their images. If dragging one in
doesn't work, right-click it, choose **Copy Image**, and paste it instead.

## Roadmap

1. ✅ Canvas with drag-and-drop images, pan and zoom
2. Split viewports sharing the same canvas
3. Saving and loading
4. Drawing and notes
5. Image search (Unsplash, Pexels, Openverse)

## How the code is organised

There's no build step: the files are served as they are.

- `index.html`, `style.css`: the page and its look
- `src/main.js`: starts the app and connects the mouse, keyboard, drop and paste
- `src/board.js`: the shared canvas and the images on it
- `src/camera.js`: one view onto the board (pan and zoom)
- `src/importer.js`: getting images in from files, other tabs and the clipboard
- `vendor/pixi.min.mjs`: [PixiJS](https://pixijs.com) 8.22, the fast WebGL renderer

To run it on your own computer, serve the folder with any local web server, for example
`python3 -m http.server`, then open http://localhost:8000.
