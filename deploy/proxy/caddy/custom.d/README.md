# `custom.d`

The single extension point of the Caddy profile, matching `custom.d` in the
nginx one (section 21.2). Every `*.caddy` file here is copied into the rendered
configuration and imported at the end of the site block:

```caddyfile
import custom.d/*.caddy
```

`render-proxy` never rewrites or deletes these files. Everything else under
`deploy/proxy/caddy/` is a template and is overwritten on every render.

A file Caddy refuses never goes live: the render is validated with
`caddy validate` before it replaces the running configuration, which stays as
it was.
