# Contributing

- Open a PR against `main`; use a Conventional Commit title (`fix:`, `feat:`,
  `docs:`, `ci:`, `chore(deps):`, etc.). Changes are squash-merged.
- Run `npm ci --ignore-scripts` and `npm run check`. For runtime/dependency changes,
  also run `npm run test:install` and `npm run test:pi`.
- Use synthetic fixtures. Never commit credentials, production memories or unrelated
  generated files. Mock-model tests are not live-model accuracy evidence.
- Update English documentation by default and keep `README.cn.md` aligned.
- Do not manually edit release versions/tags for routine changes. Release Please
  prepares the version/changelog PR; the release workflow publishes after verification.
- Review dependency and workflow changes even when checks pass. The gate does not
  replace maintainer review or authorize unsafe code.

See [testing](docs/testing.md) and [release automation](docs/releasing.md).
