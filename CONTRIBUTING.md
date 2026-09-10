# Contributing

Pinocchio has configuration-bound identity, local SQLite administration and
worker-backed keyword-memory tools with development enrollment, not a production
installer. The production identity gate is verified on the pinned
public CLI/Linux baseline; shared caller-metadata inference remains unsupported.

Read [the design](docs/DESIGN.md), [installation requirements](docs/INSTALL.md)
and [privacy policy](PRIVACY.md) before proposing changes.

## Public-safe contributions

- Use synthetic data and generic paths only. Do not upload private logs,
  configurations, real notes, internal repositories, or personal information.
- Keep runtime state outside the repository; review staged changes rather than
  relying solely on ignore rules.
- Use a public Git identity with a GitHub noreply email. Do not introduce private
  author/committer addresses into public history.
- Do not publish private-build details or claim compatibility based only on
  unpublished environments.
- Never ask a reporter to attach their real memory database or complete session.

## Changes and evidence

Keep pull requests focused and explain the behavior they change. Distinguish
proposed behavior from implemented, measured behavior.

For implementation changes, include synthetic coverage of the relevant acceptance
criteria. In particular, memory writes require idempotency, source/scope checks,
and clear failure reporting. Unknown identity must not fall back to a parent's
store.

Supported platforms and host versions will be established by clean installation
and lifecycle checks. A CLI result does not establish desktop-app support.
Do not add install commands to the release instructions until they exist and
work on the advertised platform.

## Development

Use Node.js 22.18.0 (`.node-version`), then `npm ci`, `npm run typecheck` and
`npm test`. The full suite includes a pinned public runtime and a scripted
loopback provider; no authentication or real model is required.

See [the compatibility report](docs/COMPATIBILITY.md) for module boundaries,
reproduction details and the difference between passing fail-closed tests and
passing the production identity gate. See [BINDINGS.md](docs/BINDINGS.md) for local
registration, revocation and the adapter contract. CI uploads only synthetic summaries, never raw
host logs or session state.

See [STORAGE.md](docs/STORAGE.md) for the administrative CLI, schema, retry
protocol and migration boundaries. Storage tests use invented records and
independent processes; never substitute a real memory store in these fixtures.

## License

Contributions must be compatible with the repository's [MIT license](LICENSE).
Do not copy code or data that you do not have permission to contribute.
