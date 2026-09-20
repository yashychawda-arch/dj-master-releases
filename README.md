# Yoshi C's DJ Master — releases

Installers only. The source lives in a private repository.

`latest.json` is what the app reads when it checks for an update: the current version, one line about
it, and where to get it. Nothing about you or your computer is sent when it looks.

Each release carries two files:

- `Yoshi C's DJ Master <version> Setup.exe` — Windows. Run it.
- `Yoshi C's DJ Master <version> (Mac).zip` — Mac. Unzip it and run `Install.command`
  (right-click → Open the first time, since it isn't signed yet).

**You need an activation key to run it.** The app shows an installation ID for your computer the first
time it opens; send that to Yoshi and he'll send a key back. One key works on one computer.

Set `min_version` in `latest.json` to mark an update as required: anything older says so plainly and
can't dismiss the notice.

© 2026 Yoshi C. Licensed for personal use — see `LICENSE.txt` inside the installer.
