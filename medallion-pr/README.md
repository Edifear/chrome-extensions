# Medallion PR

Chrome extension to track unread PRs and issues in [trymedallion/medallion](https://github.com/trymedallion/medallion).

## Setup

1. **Create a GitHub PAT** (classic) with `repo` scope at [github.com/settings/tokens](https://github.com/settings/tokens)
2. **Add token to `.env`** in the repo root:
   ```
   GITHUB_DEV_TOKEN=ghp_your_token_here
   ```
3. **Install the extension**:
   - Open `chrome://extensions`
   - Enable **Developer mode** (top right)
   - Click **Load unpacked** → select the `medallion-pr/` folder
4. The token is loaded automatically from `.env` on install. If you update the token, reload the extension.

## Usage

### Adding search queries

Each item is a GitHub search query that runs against the `trymedallion/medallion` repo. Click the input field, type a query, and click **Add**.

Examples:
- `is:open author:Edifear` — your open PRs
- `is:open review-requested:Edifear` — PRs awaiting your review
- `is:open -author:Edifear (user-review-requested:Edifear OR reviewed-by:Edifear)` — PRs you're involved in reviewing (OR queries are supported)

The **Title** field is optional — use it to give items a human-readable label.

### Reading results

- **Grey** left border — not yet synced
- **Green** left border — all read
- **Red** left border (pulsing) — has unread items

Click an item to expand and see individual PRs with their review status:
- ✓ green circle — approved
- ✗ red circle — changes requested
- ○ grey circle — review pending

Unread PRs are highlighted with a **blue left border** and bold title. Items with unread PRs auto-expand when the popup opens.

### Syncing

- **Auto-sync** runs every 1 minute in the background
- **Manual sync** — click the **Sync** button; a toast shows the total count
- The extension **badge** shows how many items have unread results

### Other features

- **Open in GitHub** — hover an item and click the external link icon to open the search on GitHub
- **Remove** — hover and click ✗
- **Light/dark mode** — toggle with the moon/sun icon in the header
- **Persisted items** — your search queries survive extension reinstalls (synced via Chrome account)
