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
| `/config` | SQLite database, covers, caches, Calibre settings, and nightly database backups in `/config/backups`. |
| `/books` | Your library as plain files. The database can be rebuilt by rescanning it. |
| `/audiobooks` | Optional. Audiobook folders, one per book (the Audiobookshelf layout works). Can be mounted read-only unless you reject audiobooks from the inbox. |

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `PUID` / `PGID` | `1000` / `1000` | Owner of files the app writes. Unraid: `99` / `100`. |
| `UMASK` | `022` | Use `002` so the group can write too. |
| `TRUSTED_PROXIES` | empty | IPs/CIDRs of your reverse proxy. Auth headers from anywhere else are ignored. |
| `AUTH_HEADER_EMAIL` | `remote-email` | Header the proxy (Tinyauth) sets with the signed-in email. |
| `GOOGLE_SIGN_IN_URL` | empty | Your Tinyauth login page. When set, the sign-in screen shows a "Sign in with Google" button. Username/password sign-in works without it. |
| `PUBLIC_URL` | empty | Bookbandit's address as people reach it, e.g. `https://books.example.com`. Needed for single sign-on. |
| `SSO_ISSUER` | empty | Single sign-on: your Tinyauth (or other OpenID Connect) address, e.g. `https://auth.example.com`. See [Single sign-on](#single-sign-on-with-tinyauth). |
| `SSO_CLIENT_ID` / `SSO_CLIENT_SECRET` | empty | The client you add in Tinyauth for Bookbandit. |
| `SSO_LABEL` | `Tinyauth` | Button text: "Sign in with …". |
| `SSO_AUTO_CREATE` | `true` | A new email gets its own grown-up account (the "adult" role). `false` lets in only emails linked under People. |
| `SESSION_SECRET` | generated | Signs password/PIN sessions. Generated once and kept in the database if empty. |
| `TZ` | UTC | Time zone, e.g. `America/Chicago`. Sets when the nightly backup runs. |
| `BACKUP_TIME` | `03:00` | Nightly database backup time (`HH:MM`), or `off`. |
| `BACKUP_KEEP` | `7` | Nightly backups to keep (`0` keeps all). |
| `BACKUP_DIR` | `/config/backups` | Where backups go. Point it at another share to keep them off the cache pool. |
| `DEVICE_IDLE_DAYS` | `180` | A paired tablet that hasn't been used this long has to be paired again. `0` never expires. |
| `CONTENT_SECURITY_POLICY` | built in | Replaces the web app's Content-Security-Policy header; `off` sends none. |
| `LOG_LEVEL` | `info` | `fatal` … `trace` |
| `PORT` | `8080` | Port inside the container. |

`/config` is chowned to `PUID:PGID` on start when its owner is wrong. `/books` is never chowned,
so make sure `PUID:PGID` can read it (and write it, if you'll use uploads or downloads).
Starting the container with `--user` skips the switch and runs as that user directly.

## Single sign-on with Tinyauth

This puts a **Sign in with Tinyauth** button on the sign-in page. It's set with environment
variables on the two containers; nothing to turn on inside Bookbandit.

1. In Tinyauth, add a client for Bookbandit:

   ```
   TINYAUTH_OIDC_CLIENTS_bookbandit_CLIENTID=bookbandit
   TINYAUTH_OIDC_CLIENTS_bookbandit_CLIENTSECRET=<long random string>
   TINYAUTH_OIDC_CLIENTS_bookbandit_TRUSTEDREDIRECTURIS=https://<your-bookbandit-site>/auth/sso/callback
   TINYAUTH_OIDC_CLIENTS_bookbandit_NAME=Bookbandit
   TINYAUTH_OIDC_CLIENTS_bookbandit_TRUSTED=true
   ```

2. On the Bookbandit container (Unraid template or docker-compose), set:

   ```
   PUBLIC_URL=https://<your-bookbandit-site>
   SSO_ISSUER=https://<your-tinyauth-address>
   SSO_CLIENT_ID=bookbandit
   SSO_CLIENT_SECRET=<the same secret>
   SSO_LABEL=Tinyauth          # optional, the button text
   ```

3. Restart both containers.

Who signs in as whom: the email Tinyauth reports is matched to someone's **sign-in emails** (Admin →
People → Sign-in emails, which the admin can add to any grown-up, their own profile included). An
email nobody uses yet gets a new grown-up account with the "adult" role, so Tinyauth's approved-email
list decides who gets in; set `SSO_AUTO_CREATE=false` to let in only linked emails. If someone who
already had a profile signed in before their email was linked, open the new account's sign-in
emails on People and use **Move to…** to put the email on their real profile. The leftover account
is turned off (delete it from People if it's empty). Only admins can link or move emails.

Single sign-on talks to Tinyauth directly, so it works without forward auth and `TRUSTED_PROXIES`.
The older forward-auth setup (`TRUSTED_PROXIES` + `AUTH_HEADER_EMAIL`) still works too, and both use
the same sign-in emails.

## Backups

Every night (03:00 in `TZ`) the database is copied to `/config/backups/<date>/`, and the last 7 are
kept. An admin can also press **Back up now** on the Admin page, and download any backup from there.
A backup holds people, reading progress, bookmarks, ratings, series and settings, plus the key that
unlocks saved API keys. Your books are not in it: they stay as plain files in `/books`, and covers
and metadata come back with a rescan.

To get the backups off the server too, copy `/config/backups` with your usual backup tool
(on Unraid, the Appdata Backup plugin or a nightly rsync to the array).

To restore, stop the container and run the image's `restore` command against the same `/config`:

```sh
docker stop bookbandit
docker run --rm -v /mnt/user/appdata/bookbandit:/config ghcr.io/spacegoose02/bookbandit restore latest
docker start bookbandit
```

Use a backup's folder name instead of `latest` for an older one (`list-backups` shows them). The
database that was there is saved as a backup first, so a restore can be undone the same way.

Moving to a new server or a fresh container: copy the `backups` folder into the new `/config`,
run the same `restore latest`, then start the container.

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
