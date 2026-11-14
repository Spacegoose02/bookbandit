# Running Bookbandit in Docker

One container serves the API and the web app on port 8080. Calibre's `ebook-convert` and
`kepubify` are built in. Images are published for `linux/amd64` and `linux/arm64`:

| Tag | What it is |
| --- | --- |
| `ghcr.io/spacegoose02/bookbandit:latest` | Latest build of `main` |
| `:main`, `:sha-<commit>` | A specific build of `main` |
| `:1.2.3`, `:1.2`, `:1` | Releases (git tags `v1.2.3`) |

## Volumes

| Path | Contents |
| --- | --- |
| `/config` | SQLite database, covers, caches, Calibre settings. Back this up. |
| `/books` | Your library as plain files. The database can be rebuilt by rescanning it. |

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `PUID` / `PGID` | `1000` / `1000` | Owner of files the app writes. Unraid: `99` / `100`. |
| `UMASK` | `022` | Use `002` so the group can write too. |
| `TRUSTED_PROXIES` | empty | IPs/CIDRs of your reverse proxy. Auth headers from anywhere else are ignored. |
| `AUTH_HEADER_EMAIL` | `remote-email` | Header the proxy (Tinyauth) sets with the signed-in email. |
| `GOOGLE_SIGN_IN_URL` | empty | Your Tinyauth login page. When set, the sign-in screen shows a "Sign in with Google" button. Username/password sign-in works without it. |
| `SESSION_SECRET` | generated | Signs password/PIN sessions. Generated once and kept in the database if empty. |
| `LOG_LEVEL` | `info` | `fatal` … `trace` |
| `PORT` | `8080` | Port inside the container. |

`/config` is chowned to `PUID:PGID` on start when its owner is wrong. `/books` is never chowned,
so make sure `PUID:PGID` can read it (and write it, if you'll use uploads or downloads).
Starting the container with `--user` skips the switch and runs as that user directly.

## Docker Compose

See [`docker-compose.example.yml`](../docker-compose.example.yml).

## Unraid

Until the template is in Community Apps, download it into your user templates from the Unraid
terminal (or the web terminal, top right of the web UI):

```sh
wget -O /boot/config/plugins/dockerMan/templates-user/my-bookbandit.xml \
  https://raw.githubusercontent.com/spacegoose02/bookbandit/main/docker/unraid/bookbandit.xml
```

1. Docker tab → **Add Container** → **Template** → pick **bookbandit** under *User templates*.
2. Set **Books** to your library share and **Trusted proxies** to your reverse proxy's IP or
   Docker network (for example `172.18.0.0/16`). Leave PUID/PGID at 99/100.
3. Apply, then open the web UI through your proxy.

To list it in Community Apps, the template goes in a public templates repository and gets
submitted through the CA support thread; the XML here is ready for that.

## Building it yourself

```sh
docker build -t bookbandit .
docker/smoke-test.sh bookbandit   # converts a sample book, starts the server, checks it
```

Build args: `CALIBRE_VERSION` (default `latest`, the newest GitHub release of Calibre; CI passes the current release so a new Calibre
busts the cache) and `KEPUBIFY_VERSION`.

## Publishing (maintainers)

`.github/workflows/docker.yml` builds and smoke-tests every PR and pushes multi-arch images on
`main` and on `v*.*.*` tags. A tag also gets a GitHub Release with generated notes once its
images are pushed, so to release: `git tag v0.1.0 && git push origin v0.1.0`. The first push creates the GHCR package as **private**: open the
package on GitHub → **Package settings** → **Change visibility** → Public, so Unraid can pull
without logging in.
