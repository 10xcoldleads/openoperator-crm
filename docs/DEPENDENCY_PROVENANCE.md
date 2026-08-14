# Dependency provenance

OpenOperator deliberately avoids assembling a product from copied CRM repositories. The core is maintained in this repository; dependencies are installed from the npm lockfile and reviewed with `npm audit`.

Direct runtime dependencies are limited to established, permissively licensed projects:

- Cloudflare Vinext for the Workers-native application runtime
- React and Next-compatible interfaces for the UI contract
- Drizzle ORM for typed D1 access
- XYFlow and dnd-kit for executable workflow editing interactions
- JOSE for Cloudflare Access JWT verification, following Cloudflare's official validation pattern

The Twenty CRM repository is referenced only as documented interoperability research. No Twenty source or runtime dependency is vendored. `docs/TWENTY_INTEGRATION_MANIFEST.json` pins the reviewed upstream commit, and `npm run verify:twenty` verifies the declared upstream blobs and local contract files.

Before release, run:

```bash
npm ci
npm audit --audit-level=moderate
npm run verify:twenty
npm test
```

New dependencies require a clear functional reason, an identifiable upstream, a compatible license, a maintained release history, and a clean vulnerability review.

Capability-level upstream and sidecar decisions are maintained in
[`OPEN_SOURCE_CAPABILITY_STRATEGY.md`](./OPEN_SOURCE_CAPABILITY_STRATEGY.md).
Listing a project there is research evidence, not approval to install, clone,
copy, deploy, or connect it. Each adoption still requires the repository
admission gate at the exact selected commit or release.
