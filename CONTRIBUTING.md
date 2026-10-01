# Contributing to OpenScreen

Thanks for helping make OpenScreen better.

## Reporting bugs and requesting features

Open an [issue](https://github.com/tszaks/openscreen/issues/new/choose) and pick the bug report or feature request template. For bugs, include your OpenScreen version (OpenScreen › About), your macOS version, and the steps that cause the problem. A short screen recording helps a lot.

## Making changes

1. Fork the repository and create a branch from `main`.
2. Set up the app:
   ```sh
   cd electron
   npm install
   npm run electron:dev
   ```
3. Make your change. Keep pull requests focused on one thing.
4. Add or update tests. Anything in `electron/src/shared/` should have unit tests in `electron/test/`.
5. Make sure everything passes:
   ```sh
   npm run typecheck
   npm test
   ```
6. Open a pull request against `main` and fill in the template.

Every pull request runs the type checker and the test suite automatically, and `main` only accepts changes through reviewed pull requests with passing checks.

## Code style

- TypeScript throughout. Match the style of the code around your change.
- Keep the model layer (`electron/src/shared/`) free of Electron and DOM imports, so it stays testable.
- Never modify a user's original recording. Edits live in `project.json`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
