# Yoshi C's DJ Master — version file

This repository exists for one reason: so a copy of **Yoshi C's DJ Master** can ask whether a newer
version is out.

It contains **`latest.json` and nothing else**. There is no source code here, and there never will be —
the app's source is private.

```json
{
  "version": "1.8.0",
  "notes": "One short line about what changed.",
  "url": "https://github.com/yashychawda-arch/dj-master/releases/latest"
}
```

The app fetches that one file over HTTPS, compares `version` with its own, and if it is behind, shows a
line on its home screen. That is the entire exchange:

- nothing is sent about the person, their music, their crate or their computer — it is a plain GET;
- there is no account, no identifier and no logging beyond GitHub's own;
- it can be switched off in the app under **Settings → Tell me when a new version is out**, and with it
  off nothing is requested at all.

Downloads live on the private repository's [Releases page](https://github.com/yashychawda-arch/dj-master/releases),
which Yoshi shares directly.

## Releasing

Bump `version` here **after** the release is published, so nobody is pointed at a download that isn't
there yet. Keep `notes` to one sentence — the app trims it to 160 characters and strips anything that
isn't plain text.
