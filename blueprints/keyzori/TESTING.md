# Testing Keyzori

Start a local Docker engine with Compose v2. With Node.js 18+ and pnpm 9,
install the existing validation dependencies and run the package scripts:

```sh
cd build-scripts
pnpm install
node generate-meta.js --check
pnpm run validate-docker-compose --file ../blueprints/keyzori/docker-compose.yml
pnpm run validate-template --dir ../blueprints/keyzori
pnpm run test:keyzori
```

The `Test Keyzori Template` workflow runs these checks for relevant pushes and
pull requests, and can also be started manually.

The test uses the unchanged Compose file, a unique project name, temporary
generated secrets, and fresh volumes. It checks missing-secret rejection,
database credentials, domain/listener alignment, startup, health/readiness/docs,
admin authentication, customer creation, and PostgreSQL/Redis persistence after
restart and container recreation. It removes its containers and volumes even
after a test failure. It does not publish host ports or use existing Keyzori data.
Docker must be running; unavailable infrastructure fails the test rather than
silently skipping it. An interrupted process may require manual cleanup of its
`keyzori-test-*` project.

The test resolves this template's `domain` and `hash` helpers locally; it does not
replace testing Dokploy's actual template processor and proxy.

## Dokploy verification

Verified on 2026-09-16 using Keyzori v1.1.0 in a fresh Ubuntu 24.04 WSL instance
with Dokploy v0.30.6, before switching the template to the moving `latest` tag:

- Imported the exact Compose/TOML payload through Dokploy's Base64 import API.
- Verified independently generated secrets and the `keyzori:3000` domain target.
- Deployed successfully, including Dokploy's isolated deployment mode.
- Requested `/health`, `/ready`, and `/docs` through Traefik: HTTP 200.
- Verified unauthenticated admin access returns 401 and authenticated customer creation returns 201.
- Verified PostgreSQL customer and Redis test data survived redeployment and service restarts.
- Removed the temporary WSL instance and all its test data afterward.

Local routing used the generated domain as the HTTP Host header. Public DNS,
HTTPS certificates, browser UI interaction, and PR preview/CI were not tested.
