# Contributing to UltraGo

Thanks for contributing. Please open an issue before substantial changes so the scope and approach can be discussed.

## Development

- Node.js 22 and pnpm 10 are required. Python tooling uses the version pinned in `.python-version` and `uv`.
- Run `pnpm install`, `pnpm python:setup`, then `pnpm init` for a local development environment.
- Run `pnpm test:python`, `pnpm --filter @bcp/shared build`, `pnpm -r typecheck`, `pnpm -r test`, and `pnpm check:books` before submitting.
- Keep changes focused and include regression tests for behavior changes.

## Pull Requests

- Use a descriptive title and explain the user-visible change, implementation, and verification.
- Do not include credentials, personal data, customer/shop data, browser exports, screenshots, or live platform captures.
- Use synthetic fixtures. Do not run tests that submit content, modify a real account, or call a live commerce API.
- Keep generated files in sync when changing playbooks or schemas.

By submitting a contribution, you agree that it may be distributed under the repository's MIT license.
