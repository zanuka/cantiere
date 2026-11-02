# Contributing to Cantiere

Thanks for helping. Cantiere is at the very beginning, so small focused PRs and design feedback are the most useful.

## Setup

Requires Node 22 LTS and pnpm 9+.

```bash
pnpm install
pnpm typecheck   # tsc -b across all packages
pnpm lint        # Biome
pnpm test        # vitest
pnpm cantiere --help
```

## Ground rules

- Read [AGENTS.md](AGENTS.md) first: it states the boundary (runtime only), the core principles and the coding standards.
- `packages/core` must not depend on CLI code.
- Mutating commands support `--dry-run`; read commands support `--json`; errors are actionable.
- Add or update tests with every behavior change.
- Never commit secrets. Use `.env.example` for placeholders.
- Use Conventional Commits for commit messages and PR titles, e.g. `feat(core): add task state machine`.

## Pull requests

1. Open or pick an issue first for anything non-trivial.
2. Keep the PR focused; link the issue with `Closes #N`.
3. CI (typecheck, lint, test on macOS and Linux) must pass.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
