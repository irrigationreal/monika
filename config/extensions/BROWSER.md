# pi-agent-browser

`pi-agent-browser` is an npm Pi package that registers the `browser` tool. It
wraps the separately installed `agent-browser` CLI and the image-owned Chromium
binary.

## Runtime installation

The Monika image pins `pi-agent-browser` in `config/settings.json`, installs the
`agent-browser` CLI in `Containerfile`, and sets
`AGENT_BROWSER_EXECUTABLE_PATH` to the image-owned browser. Pi discovers and
activates package tools normally; there is no hardcoded active-tool allowlist to
update.

The pinned CLI currently declares Node.js 24 or newer while the Monika runtime
remains on Node.js 22 until the planned Node 26 LTS migration. The native CLI path
works under the current image and is covered by runtime smoke, but this is an
explicit upstream-engine compatibility exception rather than a supported Node
combination.

After changing either package pin, rebuild the image and run:

```bash
tests/smoke/monika-runtime.sh <image>
```

The runtime smoke test exercises real Pi package loading, verifies that the
package tools sent to the provider include `browser`, and drives the pinned CLI
through the image-owned Chromium against a local page. The browser probe checks
navigation, title/text extraction, and screenshot output without depending on
external network access.
