# Linkding Sync - Project Rules

This file outlines the coding standards, patterns, and constraints for the project.

## 1. Core Constraints

- **No Build Step**: The project uses vanilla JS/HTML/CSS. Do not introduce webpack, babel, or any other build tools.
- **No NPM**: Do not use `npm` or `yarn`. Do not add a `package.json`.
- **Manifest V3**: All code must comply with Chrome Extension Manifest V3 requirements (Service Workers, no background pages).

## 2. Coding Style

- **Indentation**: 2 spaces.
- **Semicolons**: Always use semicolons.
- **Async/Await**: Preferred over Promises/Callbacks for asynchronous operations.
- **Comments**: comprehensive JSDoc-style comments for complex logic (especially in `sync.js`).

## 3. Deployment

To test changes:
1. Load the extension unpacked in Chrome (`chrome://extensions`).
2. Reload the extension after *any* change to background/popup scripts.
3. Check the console of the background worker for errors (it's separate from popup console).
