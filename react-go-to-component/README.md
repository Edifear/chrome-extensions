# React Go to Component

Chrome extension that lets you jump from any element on a React page directly to its source code in VS Code.

**Option + hover** to highlight components with a source preview. **Option + click** to open in VS Code.

## How it works

1. Hold **Option** key to enter picker mode (cursor becomes crosshair)
2. Hover over any element -- the overlay shows the React component name, file, line number, and a source code snippet
3. Click to open the file at the exact line in VS Code
4. Release **Option** to exit picker mode

The extension reads React fiber internals (`__reactFiber$`, `_debugSource`) from DOM nodes to identify components. It uses element-level `_debugSource` for precise file/line detection and skips library internals (antd, etc.) to find your project's components.

## Requirements

- React app running in **development mode** (fibers and `_debugSource` are only available in dev)
- **Vite** dev server on localhost
- **VS Code** with the `code` CLI installed (`Shell Command: Install 'code' command in PATH`)
- **macOS** (native messaging host uses macOS paths)

## Setup

### 1. Install the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked** and select the `react-go-to-component` folder
4. Note the **Extension ID** shown on the card

### 2. Configure the project root

Edit `inject.js` line 2 and set `PROJECT_ROOT` to your React project's root directory:

```js
const PROJECT_ROOT = '/Users/you/Projects/your-app';
```

This path is joined with the `_debugSource.fileName` from React fibers to form the full path opened in VS Code.

### 3. Install the native messaging host

The extension uses Chrome's [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) to call `code --goto` directly, avoiding browser protocol prompts.

```sh
cd react-go-to-component
./install-host.sh <your-extension-id>
```

This installs a small Python script and registers it with Chrome. **Restart Chrome** after running this -- native host manifests are read on startup.

### 4. Verify

1. Start your React dev server (`npm run dev`)
2. Open the app on `http://localhost:...`
3. Hold **Option** and hover over a component -- you should see the overlay
4. Click -- VS Code should open at the correct file and line

## Architecture

```
inject.js       MAIN world: fiber walking, overlay UI, hint collection
content.js      ISOLATED world: bridges inject.js <-> background.js
background.js   Service worker: routes messages to native host
native-host/    Python script: opens VS Code and reads source files
```

**Source detection** collects hints from the hovered DOM element (text content, class names, attributes) and searches the original source file on disk for the best matching line.

## Limitations

- Only works on `localhost` (dev server)
- Only works with React in development mode
- `PROJECT_ROOT` is hardcoded (edit `inject.js` to change)
- Line detection is heuristic-based -- may occasionally point to the wrong line in files with repetitive patterns
- `_debugSource` may have a `/app/` prefix from Docker-based builds (stripped automatically)
