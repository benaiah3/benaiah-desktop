# Bundled plugins

Drop a `<name>/plugin.{ts,tsx}` here that default-exports a `HermesPlugin` and
it registers automatically at boot (vite glob in `../contrib/plugins.ts`), with
the same inventory + live enable/disable contract as runtime plugins.

The first in-tree contribution is Benaiah Missions, a core product surface that
uses the same public SDK contract as third-party pages. Reference/demo plugins
(the counter example, gateway-pill rebuild and runtime-loader hello world) live
in the companion
[`hermes-example-plugins`](https://github.com/NousResearch/hermes-example-plugins).

User- and agent-authored plugins load at runtime from
`$HERMES_HOME/desktop-plugins/<name>/plugin.js` (the disk door) — see the
`hermes-desktop-plugins` skill.
