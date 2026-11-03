# Themes you can make and share

**Status: proposal.** Nothing here is built yet. This page proposes a file
format for Ateam themes, so that anyone can write one, pass it around, and
load it into Ateam. The format is the part worth agreeing on first, because
once people have written themes against it, it is hard to change.

It builds on a theme switch being added to Settings, with today's palette, a
grey dark theme and a light one. That work moves every colour in the desktop
app onto a small set of named tokens, and a theme file gives values to some
of those tokens.

## A theme file

One JSON file per theme:

```json
{
  "version": 1,
  "name": "Harbour Night",
  "type": "dark",
  "colors": {
    "bg": "#0f1720",
    "bg-elev": "#141e2a",
    "border": "#ffffff14",
    "text": "#e4ebf2",
    "text-dim": "#8da0b3",
    "blue": "#6cb6ff"
  },
  "terminal": {
    "background": "#0f1720",
    "foreground": "#e4ebf2",
    "red": "#ff7b72"
  }
}
```

- `version`: the format version. `1` for everything on this page.
- `name`: what the Theme menu shows.
- `type`: `dark` or `light`. It picks the built-in theme that fills every
  token the file leaves out, and it sets the native controls (scroll bars,
  date pickers) to match. A theme can set three colours or all of them.
- `colors`: Ateam tokens, listed below. All optional.
- `terminal`: the terminal's palette, with the key names of xterm's theme
  (`background`, `foreground`, `cursor`, `selectionBackground`, `black`,
  `red` … `brightWhite`). All optional. A missing key takes the built-in
  theme's value.

Every value is a hex colour: `#rgb`, `#rrggbb`, or `#rrggbbaa` when it should
be translucent. Translucent borders and hovers stay quiet on any surface.

## The tokens

These names are the contract. Renaming one breaks every theme that sets it,
so a token, once shipped, keeps its name.

| Token | Paints |
|---|---|
| `bg` | The board, the window behind everything |
| `bg-elev` | The sidebar, cards, panels |
| `bg-elev-2` | Buttons, chips, inputs |
| `bg-hover` | A button under the pointer |
| `bg-tooltip` | Tooltips |
| `bg-code` | Inline code in the Lead chat |
| `bg-composer` | The Lead's message box and its menus |
| `border` | Every border and divider |
| `border-hover` | A border under the pointer |
| `border-focus` | A focused text field |
| `text` | Text |
| `text-dim` | Secondary text |
| `text-faint` | Timestamps and other small print |
| `dot` | Neutral dots |
| `primary` | The primary button and the selection marks (white on dark, black on light: Ateam keeps colour out of its chrome) |
| `primary-fg` | Text on `primary` |
| `primary-hover` | `primary` under the pointer |
| `ink` | The colour light overlays are drawn in, opaque (white on dark, near black on light) |
| `scroll-thumb`, `scroll-thumb-hover` | Scroll bars |
| `term-bg` | Around and behind terminals |
| `toast-err-bg`, `toast-err-fg` | The error toast |
| `toast-info-bg`, `toast-info-fg` | The info toast |
| `diagram-line`, `diagram-surface-alt`, `diagram-border` | Diagrams in the Lead chat |
| `green`, `amber`, `red`, `blue` | Status: Review, Needs you, errors, In progress |

## What a theme cannot do

A theme is colours and nothing else: no CSS, no fonts, no images, no URLs.
That keeps an imported file harmless. It cannot load anything, run anything
or move the layout, so a theme from a stranger is as safe as a colour picker.
A value that is not a hex colour is dropped, the built-in value is used
instead, and the import says which keys it dropped.

Agent pages (`show_page`) stay on a dark background under every theme,
because agents are told to write them for one.

## Where themes live, and how to add one

- Themes are files in `~/.ateam/themes/`, named by their id:
  `harbour-night.json`. They sit next to `settings.json`, so they go wherever
  your dotfiles go.
- **Settings → General → Theme → Import theme…** opens a file picker, checks
  the file, copies it into that folder and switches to it. Dropping a file
  into the folder by hand works too; the menu lists it the next time it
  opens.
- `client.theme` in `settings.json` holds the id of the theme in use. A file
  cannot replace a built-in id.
- Sharing a theme is sharing its file: a gist, a repo, a message.

## Bringing a VS Code theme

Thousands of editor themes already exist as VS Code `*-color-theme.json`
files. **Import theme…** could accept one and translate it:

| Ateam token | VS Code key |
|---|---|
| `bg` | `sideBar.background` |
| `bg-elev` | `editor.background` |
| `bg-elev-2` | `list.hoverBackground`, drawn over `bg` |
| `bg-hover` | `list.activeSelectionBackground`, drawn over `bg` |
| `border` | `sideBar.border` |
| `border-hover` | `focusBorder` |
| `text`, `primary` | `foreground` |
| `text-dim` | `input.placeholderForeground` |
| `primary-fg` | `editor.background` |
| `term-bg` | `terminal.background` |
| `green` | `gitDecoration.addedResourceForeground` |
| `amber` | `gitDecoration.modifiedResourceForeground` |
| `red` | `gitDecoration.deletedResourceForeground` |
| `blue` | `charts.blue`, else `textLink.foreground` |
| `terminal.*` | `terminal.ansi*`, `terminal.foreground`, `terminal.selectionBackground` |

`type` comes from the theme's `uiTheme` (`vs-dark` or `vs`). The result is
saved as an Ateam theme file, so it can be edited like any other. A theme
someone imports is theirs to use; Ateam doesn't ship or share it for them.

## Open questions

1. **Is the token list right?** Thirty-odd tokens is more than most theme
   authors will touch. The first eight or so (`bg` to `text-dim`), plus the
   status colours, carry most of the look. Fewer, broader tokens would be
   easier to write and harder to get right everywhere.
2. **Should `primary` be allowed a colour?** Ateam's chrome has none on
   purpose. A theme could still choose one, or the format could leave
   `primary` out.
3. **The phone.** Ateam Go has its own screens. Should a theme apply there
   too, and should it follow the Mac or be chosen per device?
4. **A shared gallery**, later, so themes can be found without passing files
   around.
5. **Agent pages.** Could pages be told the theme, so they draw in it instead
   of always on dark?
