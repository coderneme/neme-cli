# neme-world

Publish a web game to [neme.world](https://neme.world) from the command line.

If your game runs in a browser tab from static files, it runs on neme.world: any engine, any framework,
hand-written or AI-assisted. You keep your own site; neme.world is one more place people can find and play it.

```sh
npx neme-world init        # writes neme.json
npx neme-world publish     # uploads your build and puts it live
```

## Before you publish

1. Create an account at [neme.world](https://neme.world/signup). Anyone can; there is no waiting list. Confirm
   your email address from the link you are sent, then make an API token in your dashboard.
2. Put the token in your environment: `export NEME_TOKEN=neme_…`
3. Build your game the way you normally do.

Your game is live at its own link the moment you publish it. It joins neme.world's home page and search once we
have looked at your first game; your later games appear at once.

## neme.json

```json
{
  "slug": "my-game",
  "title": "My Game",
  "description": "One or two sentences players will see.",
  "tags": ["arcade"],
  "dir": "dist",
  "cover": "cover.png"
}
```

| Field | Meaning |
| --- | --- |
| `slug` | The game's address: `neme.world/g/<slug>`. Lowercase letters, numbers, hyphens. |
| `title` | Shown to players. |
| `description` | Shown on the game's page and in link previews. |
| `tags` | Up to 8, used for browsing. |
| `dir` | Folder holding your built `index.html`, relative to `neme.json`. Default `.` |
| `entry` | The HTML file to open, if it isn't `index.html`. |
| `cover` | An image inside `dir`. Leave it out and neme.world takes a screenshot for you. |
| `aspect` | Shape of the game on its page: `16:9` (default), `4:3`, `1:1`, `3:4` or `9:16`. |
| `controls` | What the game plays with: any of `keyboard`, `mouse`, `touch`, `gamepad`. Players on a device that doesn't fit are told before they start. |
| `license`, `sourceUrl`, `credit` | Optional, for open-source games and attribution. |

## What publish does

It uploads `dir` file by file as a new version, which goes live at once. Only files that changed since your last
publish are sent, so updating a large game is quick. Hidden files (anything starting with a dot) and
`node_modules` are never uploaded. Every version is kept, and you can make any earlier one live again from your
dashboard.

A single file can be up to 95 MB, and a game up to 1 GB. One publish per game runs at a time: starting a second
replaces the first.

## Previews

```sh
npx neme-world publish --preview    # uploads the build, prints a link to try it; players are not affected
npx neme-world promote 7            # makes version 7 live
```

`promote` also takes you back to an earlier version.

## Options

Installed (`npm i -D neme-world`), the command is simply `neme`.

```
neme publish [dir]      Publish the game described by dir/neme.json (default: current folder)
neme init [dir]         Create a neme.json

neme promote <n> [dir]  Make version n live

--preview               Upload without going live
--token <token>         API token (default: $NEME_TOKEN)
--api <url>             Platform address (default: $NEME_API or https://neme.world)
```

## In CI

```yaml
- run: npm run build
- run: npx neme-world publish
  env:
    NEME_TOKEN: ${{ secrets.NEME_TOKEN }}
```

## Talking to the player

To report load time, scores and your own events to your dashboard, see the SDK section of the
[developer guide](https://neme.world/developers).

MIT licensed.

## Versions

A game keeps a limited number of versions (200). `neme versions` lists them and says which one players are on;
`neme delete 3` deletes version 3 for good. The version players are on cannot be deleted: make another live first.

## For coding agents

`neme mcp` runs the same commands as tools for an AI coding agent, over the Model Context Protocol. Add it to
your agent's MCP servers:

```json
{ "mcpServers": { "neme": { "command": "npx", "args": ["-y", "neme-world", "mcp"], "env": { "NEME_TOKEN": "neme_…" } } } }
```

Tools: `neme_guide` (how to make a game that works on neme.world), `neme_init`, `neme_publish` (with `preview`),
`neme_promote`, `neme_versions`, `neme_delete_version` and `neme_metrics`. The agent is told to upload a preview, show you the link, and make a version
live only when you say so. The guide it reads is also at https://neme.world/llms.txt.
