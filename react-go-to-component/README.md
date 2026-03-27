# React Go to Component

Chrome extension that lets you jump from any element on a React page directly to its source code in VS Code.

Hold the activation key and hover to highlight components with a source preview. Click to open in VS Code. All settings are configurable via the extension popup.

## How it works

1. Hold the activation key (default: **Option**) to enter picker mode (cursor becomes crosshair)
2. Hover over any element -- the overlay shows the React component name, file, line number, and a source code snippet
3. Click to open the file at the exact line in VS Code
4. Release the key to exit picker mode

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

### 2. Configure settings

Click the extension icon in Chrome's toolbar to open the popup. Configure:

- **Project root** -- full path to your frontend project (e.g., `/Users/you/Projects/repo/frontend_service`)
- **Activation key** -- key or combo to activate picker mode (default: Option). Click the field and press your preferred keys.
- **Show code preview** -- toggle the source code snippet in the overlay

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
3. Hold your activation key and hover over a component -- you should see the overlay
4. Click -- VS Code should open at the correct file and line

## Architecture

```
inject.js       MAIN world: fiber walking, overlay UI, hint collection
content.js      ISOLATED world: bridges inject.js <-> background.js
background.js   Service worker: routes messages to native host
native-host/    Python script: opens VS Code and reads source files
```

**Source detection** collects hints from the hovered DOM element (text content, class names, attributes) and searches the original source file on disk for the best matching line.

## Known issues

- **Detached/repositioned elements** -- elements that are visually detached from their original DOM position may not resolve to the correct component. This includes elements wrapped in Ant Design's `<Affix>`, sticky/fixed table headers, and similar patterns where the rendered DOM is moved or cloned away from the React tree. The extension skips library internals (configurable via "Skip directories"), but the fiber walking may still land on an unexpected ancestor component in these cases.

## Limitations

- Only works on `localhost` (dev server)
- Only works with React in development mode
- Line detection is heuristic-based -- may occasionally point to the wrong line in files with repetitive patterns
- `_debugSource` may have a `/app/` prefix from Docker-based builds (stripped automatically)
