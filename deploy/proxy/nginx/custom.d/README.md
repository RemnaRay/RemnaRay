# `custom.d`

The single extension point of the nginx profile (section 21.2). Every `*.conf`
file here is copied into the rendered configuration and included inside the
main `server` block:

```nginx
include custom.d/*.conf;
```

`render-proxy` never rewrites or deletes these files, so they survive an
upgrade and a re-render. Everything else under `deploy/proxy/nginx/` is a
template and is overwritten on every render — edit the templates, not the
output.

A file nginx refuses never goes live: the render is validated with `nginx -t`
before it replaces the running configuration, which stays as it was.
