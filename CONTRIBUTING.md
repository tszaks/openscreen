# Contributing to OpenScreen

Thanks for helping make OpenScreen better. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

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
   npx tsc -p tsconfig.main.json --noEmit
   npm test
   ```
6. Open a pull request against `main` and fill in the template.

Every pull request runs the type checker and the test suite automatically, and `main` only accepts changes through reviewed pull requests with passing checks.

## Pull request checklist

- [ ] `npm run typecheck`, `npx tsc -p tsconfig.main.json --noEmit` and `npm test` pass.
- [ ] New logic in `electron/src/shared/` has a unit test in `electron/test/`.
- [ ] The change is small and focused. Unrelated cleanups go in their own pull request.
- [ ] The code matches the surrounding style and adds no dependency without discussion.
- [ ] A user-visible change has a line under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- [ ] If an editor control changed, the matching agent op and the table in [AGENTS.md](AGENTS.md) changed too.
- [ ] A visible change has a screenshot, ideally light and dark.

## Code style

- TypeScript throughout. Match the style of the code around your change.
- Keep the model layer (`electron/src/shared/`) free of Electron and DOM imports, so it stays testable.
- Never modify a user's original recording. Edits live in `project.json`. Any change that touches recording, importing, saving or export needs a test, because losing a take is the worst bug OpenScreen can have.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## Using AI agents to contribute

Fine, as long as you read and understand what you submit and the checklist above is true. [AGENTS.md](AGENTS.md) tells coding agents how this repository works.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
