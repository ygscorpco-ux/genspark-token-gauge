# Genspark Token Gauge

Chrome extension for tracking estimated token usage in Genspark chat sessions.

## Features

- Floating token gauge inside `genspark.ai`
- Warning thresholds for notice, warning, danger, and critical states
- Input preview showing estimated token impact before sending
- Markdown export for chat history
- Local dashboard with saved session history
- Basic auto-reset when a new chat or compression pattern is detected

## Install

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select this folder.

## Files

- `manifest.json`: Chrome extension manifest
- `content.js`: In-page gauge, scan logic, export, toast, and input preview
- `popup.html`: Extension popup UI
- `popup.js`: Popup settings and dashboard logic

## Local Development

1. Edit the source files in this repository.
2. Reload the extension from `chrome://extensions`.
3. Open a Genspark chat page and verify the gauge behavior.

## Notes

- The extension stores settings and chat history in `chrome.storage.local`.
- Token counts are estimated heuristically, not pulled from an official API.
