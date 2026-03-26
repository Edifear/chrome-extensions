# React Go-to-Component Chrome Extension

## Context

When developing React apps, navigating from a rendered UI element back to its source component is a common workflow friction. React DevTools can show the component tree, but jumping from "this thing on screen" to "the exact file and line in VS Code" requires multiple steps. This extension adds a single right-click context menu that shows the React component ancestry and opens any component directly in VS Code.

**Scope:** Vite dev-mode React apps only (first iteration). Project root path is hardcoded.

## Architecture

```
react-go-to-component/
├── manifest.json     # MV3 manifest
├── background.js     # Service worker: context menu management, vscode:// URL opening
├── inject.js         # MAIN world: React fiber reading, DOM event listener
├── content.js        # ISOLATED world: bridges inject.js <-> background.js
└── icons/            # 16, 48, 128 PNG icons
```

### Manifest V3 Configuration

```json
{
  "manifest_version": 3,
  "name": "React Go to Component",
  "version": "1.0",
  "description": "Right-click any React element to open its source component in VS Code",
  "permissions": ["contextMenus", "activeTab"],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["http://localhost:*/*", "http://127.0.0.1:*/*"],
      "js": ["inject.js"],
      "world": "MAIN",
      "run_at": "document_start"
    },
    {
      "matches": ["http://localhost:*/*", "http://127.0.0.1:*/*"],
      "js": ["content.js"],
      "world": "ISOLATED",
      "run_at": "document_start"
    }
  ],
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

**Key decisions:**
- `matches` restricted to localhost — this is a dev-only tool
- Two content scripts with different worlds (same pattern as console-hacker extension)
- `contextMenus` permission for dynamic context menu items
- No `storage` permission needed (hardcoded config for v1)

## Data Flow

### Step 1: Capture right-click target (inject.js — MAIN world)

On `contextmenu` event:
1. Get the event target DOM element
2. Find the React fiber: `Object.keys(el).find(k => k.startsWith('__reactFiber$'))`
3. Walk `fiber.return` up the tree, collecting components where `typeof fiber.type === 'function'`
4. For each component, extract:
   - `fiber.type.name` — component name (e.g., "Button")
   - `fiber._debugSource.fileName` — source file path
   - `fiber._debugSource.lineNumber` — line number
   - `fiber._debugSource.columnNumber` — column number
5. Dispatch a custom DOM event `__react-goto-component` with the component list as detail

### Step 2: Bridge to service worker (content.js — ISOLATED world)

On receiving the custom DOM event:
1. Extract the component list from `event.detail`
2. Send it to the background service worker via `chrome.runtime.sendMessage({ type: 'UPDATE_COMPONENTS', components: [...] })`

### Step 3: Build context menu (background.js — service worker)

On receiving `UPDATE_COMPONENTS` message:
1. `chrome.contextMenus.removeAll()` — clear previous items
2. Create a parent menu item: "Go to Component"
3. For each component in the list, create a child menu item:
   - Title: component name (e.g., "Button", "Header", "App")
   - Ordered from innermost (nearest) to outermost (root)
4. Store the component data mapped by menu item ID

On `chrome.contextMenus.onClicked`:
1. Look up the component data for the clicked menu item ID
2. Construct the VS Code URL: `vscode://file/${projectRoot}${fileName}:${lineNumber}:${columnNumber}`
3. Open via `chrome.tabs.create({ url })` — Chrome hands `vscode://` to the OS protocol handler, which launches VS Code

### Project Root Configuration

For v1, hardcoded at the top of `inject.js`:

```javascript
const PROJECT_ROOT = '/Users/sergii/Projects/my-app';
```

The `_debugSource.fileName` from React typically gives paths like `/src/components/Button.tsx`. The full VS Code URL becomes:
```
vscode://file/Users/sergii/Projects/my-app/src/components/Button.tsx:42:8
```

## Component Detection Details

### Fiber Walking Algorithm

```javascript
function getComponentAncestry(element) {
  const fiberKey = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
  if (!fiberKey) return [];

  const components = [];
  let fiber = element[fiberKey];

  while (fiber) {
    if (typeof fiber.type === 'function' && fiber._debugSource) {
      components.push({
        name: fiber.type.displayName || fiber.type.name || 'Anonymous',
        fileName: fiber._debugSource.fileName,
        line: fiber._debugSource.lineNumber,
        col: fiber._debugSource.columnNumber
      });
    }
    fiber = fiber.return;
  }

  return components; // innermost first
}
```

### Edge Cases

- **Anonymous components:** Use `'Anonymous'` as fallback name — still clickable if `_debugSource` exists
- **No fiber found:** Element is not inside a React app — context menu shows nothing (or a disabled "No React component found" item)
- **No `_debugSource`:** Component exists but source info stripped — skip it in the list
- **Forwarded refs / HOCs:** `displayName` takes priority over `name` for wrapped components
- **Multiple React roots:** Each root has its own fiber tree — walking from the clicked element naturally stays within its root

## Context Menu Structure

When right-clicking inside a `<Button>` that's inside `<Nav>` inside `<Header>` inside `<App>`:

```
[React: Go to Component]  -->  Button (Button.tsx:12)
                               Nav (Nav.tsx:8)
                               Header (Header.tsx:15)
                               App (App.tsx:3)
```

- Parent item: "React: Go to Component"
- Child items: one per component, innermost first
- Menu item title includes component name and short file reference for clarity
- If no React component found: single disabled item "No React component found"

## Verification

### Manual Testing

1. Load the extension in Chrome via `chrome://extensions` (developer mode, "Load unpacked")
2. Open a Vite React dev app on localhost
3. Right-click on a UI element
4. Verify "React: Go to Component" submenu appears with correct component names
5. Click a component name — VS Code should open to the correct file and line
6. Right-click on a non-React page (e.g., google.com) — verify no menu or disabled state
7. Right-click on a plain HTML element within the React app — verify it still walks up to the nearest component

### What to Watch For

- Context menu items update correctly when right-clicking different elements
- VS Code URL opens the correct file at the correct line
- No console errors from the extension
- Performance: fiber walking should be near-instant (< 5ms for typical component trees)
