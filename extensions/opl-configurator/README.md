# opl-configurator

A generic, extensible configuration shell for the OPL extension kit. It owns the `/configurator` command and a small tab bar; each instrumented extension publishes one tab, and the user switches between tabs by tapping the tab's hotkey (much like the footer's reorder view is reached with `r`).

The shell itself has no configuration and no tools.

## How an extension opts in

An instrumented extension registers one entry on `globalThis.__oplConfiguratorTabs` at load time:

```ts
const tab = {
  id: "opl-footer",
  hotkey: "f",
  label: "Footer",
  create(api) {
    return {
      render(width) {},
      invalidate() {},
      handleInput(data) {},
    };
  },
};
```

- `id` is a unique extension id (the hotkey and id must not collide with another tab).
- `hotkey` is a single lowercase letter the shell uses to focus the tab.
- `label` is the short text in the tab bar.
- `create(api)` returns a component with the same contract as `ctx.ui.custom`'s return value. `api` carries `{ ctx, tui, theme, keybindings, done }`.

The shell reads the registry lazily when `/configurator` runs, so extension load order does not matter. Entries are validated rather than trusted: malformed entries and duplicate ids or hotkeys are dropped, and a tab whose `create` throws is skipped without taking the whole configurator down.

## Keyboard model

The shell reserves two things: `esc` closes the configurator, and each tab's hotkey focuses that tab. Everything else is delegated to the active tab, which keeps its own keys (the footer tab still uses `←`/`→` for its layout tabs and `r` for reorder). `create` is called again on every `/configurator` invocation, so a tab starts in a fresh state each time.

## Extension features

- **`/configurator`** command only; no tools and no config file.
- Ships a tab for each instrumented extension installed beside it: `f` footer (`opl-footer`), `i` input (`opl-input`). With no instrumented extension present, the command reports that nothing is wired up yet.