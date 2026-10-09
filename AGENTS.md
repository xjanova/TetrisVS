# Notes for contributors and coding agents

## Player-visible changes get a `Devlog:` line

XMAN GAMES HUB shows players this game's development timeline. Every deploy rebuilds it
(`tools/hub-publish.mjs` → `/play/tetrisvs/devlog.json`) from `DEVLOG.md` plus the
`Devlog:` lines in commit messages.

- A commit that changes something a player can see or feel gets one or more lines in its
  message body, in Thai, written for players, one change per line:

      Devlog: ยานยิงได้เร็วขึ้นเมื่อเก็บพาวเวอร์อัป

- Only the message body is read: a subject line that starts with `Devlog:` is ignored.
- Commits without one (refactors, CI, docs, releases) stay off the timeline.
- Never name the code host, people, emails, branches or tools in these lines. The publisher
  leaves out lines that name the code host or have no Thai, and strips anything email-like.
- Lines are filed under the commit's day (Asia/Bangkok). A day that already has a
  `## YYYY-MM-DD` section in `DEVLOG.md` gets them appended; any other day becomes its own
  entry, titled with its first line. A line already on the timeline is not repeated.
- A pushed commit cannot be edited. To take a wrong line off the timeline, add its exact
  text to `"devlogHide"` in `hub.json` (create the file if needed).
- `DEVLOG.md` still holds the summary (`>`), status (`**สถานะ:**`), hand-written milestones
  and the plans (`## แผนต่อไป`) — plans cannot come from commits.
