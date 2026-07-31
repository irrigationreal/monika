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

After changing either package pin, rebuild the image and run:

```bash
tests/smoke/monika-runtime.sh <image>
```

The runtime smoke test exercises real Pi package loading and verifies that the
package tools sent to the provider include `browser`.
