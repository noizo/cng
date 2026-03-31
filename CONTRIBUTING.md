# Contributing to CNG

All contributions are welcome — bug reports, feature requests, and pull requests.

## Getting started

```bash
git clone https://github.com/noizo/cng.git
cd cng
npm test
```

## Development

CNG is a zero-dependency project. All source lives in `src/` and tests in `test/`.

```bash
npm test           # Run tests
npm run bundle     # Build single-file bundle → dist/cng.js
npm run deploy:dry # Dry-run deploy
```

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Make your changes.
3. Run `npm test` and ensure all tests pass.
4. Submit a pull request.

## Reporting bugs

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Worker environment (free/paid, KV enabled or not)

## Code style

- No external dependencies.
- Single-file deployable bundle.
- All HTML/JS for the config panel lives in `src/ui.html`.
