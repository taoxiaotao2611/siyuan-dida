# SiYuan Dida Sync (Windows)

A Windows-only SiYuan desktop plugin that syncs Markdown todo blocks with Dida (TickTick) through the local `dida` CLI.

## Before you start

This plugin runs a command on your own computer. This revision supports SiYuan Desktop on **Windows only**; it does not run on macOS, Linux, mobile, Docker, or browser installations. Your Dida account, CLI installation, and authorization stay on each device.

## Install and authorize the Dida CLI

1. Open the [official Dida CLI guide](https://help.dida365.com/articles/7464976698707017728) and install the CLI for your computer.
2. Follow that guide to sign in or authorize the CLI on this device.
3. In a terminal, verify that the command is available:

   ```sh
   dida --version
   ```

   Safe task-snapshot recovery in this plugin release is verified against Dida CLI `0.1.10` and `0.1.14` (the current latest release). Other CLI versions are intentionally rejected until their result limits and date-filter behavior have been verified. When that safety check fails—or when an incomplete-task response reaches the CLI's 200-item limit—the plugin blocks recovery and new unbound task creation instead of risking duplicates.

4. Install **Dida Sync** from the SiYuan Bazaar and enable it. If SiYuan cannot find the command, open the plugin settings and enter `dida` or the command's absolute path. On Windows this is usually a `dida.cmd` path.

Repeat these steps on every computer that uses the plugin. The plugin stores resolved executable paths per device, so one computer's path is not used by another.

## Configure your first sync

1. Open **Settings → Dida Sync** in SiYuan.
2. Choose **Test connection**, then **Refresh Dida lists**.
3. Under **Sync ranges**, choose a SiYuan notebook, document path, target Dida list, and whether child documents are included.
4. Choose the default date for newly created Dida tasks:
   - **Today (all-day)** creates new Dida tasks dated today. This is the default.
   - **No date** creates new Dida tasks without a date.
5. Save settings, then use the top-bar sync button to run the first sync.

## What syncs

- An unchecked SiYuan Markdown todo creates a Dida task in its configured target list.
- Every task created by the plugin has visible Dida task content containing `SiYuan-Block-ID: <block-id>`. This stable source marker lets the plugin reconnect the task to its SiYuan block after a known partial failure.
- Editing the title of a bound, incomplete SiYuan todo updates its Dida title.
- Completing a bound SiYuan todo completes its Dida task.
- Completing a bound Dida task marks the matching SiYuan todo completed.
- Todo nesting is preserved when the parent todo is also bound.

Before creating unbound tasks, the plugin reads both incomplete and completed task snapshots from every configured Dida list. A unique source marker can restore a missing binding, update a changed SiYuan title in Dida, restore the parent relationship, and reconcile completion in either direction. This also prevents another task from being created after known failures such as a lost CLI response or a failed SiYuan attribute write.

Recovery stops safely if the same source marker appears on multiple Dida tasks. If either the incomplete or completed snapshot is unavailable, the plugin does not recover or create unmatched, unbound tasks during that run. Already-bound tasks can still be updated or completed when their operation does not depend on the missing snapshot.

## Automatic sync

Enable **Automatic sync** in plugin settings and select an interval of at least five seconds. Only one sync runs at a time on the current device; an overlapping trigger is skipped.

The settings page includes a live status panel showing the current state, last finish time, and the latest counters. Use **Sync now** there to start a manual sync. Status summaries and logs are fully localized in Chinese and English and report scanned, created, recovered, updated, completed, written-back, skipped, and failed items.

## List to document sync

**List → document sync** mirrors Dida lists into SiYuan documents. Each configured target is one Dida list, optionally one kanban column of it, and one SiYuan document. Add as many targets as needed with **Add sync target**; every enabled target runs in each sync.

1. Open the **List → document sync** section in plugin settings and use **Add sync target**.
2. Pick the Dida list (and optionally a kanban column), the target SiYuan notebook, and the target document path (for example `/Dida tasks`). The document is created automatically when it does not exist.
3. Enable the target and run a sync, manually or automatically. The mirror shares the same sync runs and logs as the todo synchronization.

Each mirrored block renders one Dida task on two lines (in-block line break):

```text
<title>
 YY.MM.DD HH:MM 时间点待办

<title>
 YY.MM.DD HH:MM开始 将历时XhYm
```

Point-in-time tasks use `时间点待办`; tasks with a start/end range use `HH:MM开始 将历时XhYm`. Tasks without a date keep only the title. When a mirrored task disappears from the open list, its block stays in place with a bold prefix: `**【已完成】**` when the task still exists as completed, or `**【已删除】**` when it no longer exists. Blocks are never deleted, so the document keeps a visible history.

Mirrored blocks carry a hidden `custom-dida-doc-task-id` attribute, which keeps the mirror idempotent: unchanged runs write nothing, changed tasks update in place, and new tasks are appended. Point this feature at a document outside your reverse-sync ranges so the two directions stay in separate notes.

## Sync range safety

Sync ranges in the same SiYuan notebook cannot cover the same document scope. The settings page rejects identical paths and parent/child overlaps when the parent range includes child documents. Sibling paths and equivalent paths in different notebooks remain valid.

If an older saved configuration contains missing fields, duplicate ranges, or overlapping ranges, all manual, startup, and automatic sync is blocked until the configuration is corrected and saved. This avoids assigning a block to an ambiguous destination.

Changing a range's target Dida list affects only newly created tasks. Existing bindings stay in their original Dida lists and are not migrated automatically; the settings page warns about this before saving.

A range can optionally be limited to one kanban column of its target Dida list. The column only scopes which Dida tasks the range may match. The CLI cannot choose a column when creating a task, so newly created tasks appear in the list's default column.

## Data storage

Stable plugin settings are stored under the workspace `conf/siyuan-dida-revision-win/` directory. Sync logs and rotating cursor state are stored under `temp/siyuan-dida-revision-win/`, outside SiYuan note data and data history. Logs retain the latest 20 runs. Version 1.3.1 migrates the former `conf/siyuan-dida/` and `temp/siyuan-dida/` directories, and also migrates the former `data/storage/petal/siyuan-dida/settings.json` file, after the new files are written successfully.

## Troubleshooting

- **Dida CLI is unavailable:** run `dida --version` in a terminal first. If it works there but not in SiYuan, enter the absolute executable path in settings and test again.
- **A task snapshot reports an unsupported CLI version:** install a verified Dida CLI release: `0.1.14` (latest) or `0.1.10`. This release fails safely on other versions until their snapshot protocol has been verified.
- **No Dida lists appear:** authorize the CLI again using the [official guide](https://help.dida365.com/articles/7464976698707017728), then refresh lists.
- **A task did not sync:** confirm that its notebook and path belong to a configured range, then review the plugin sync log.
- **New tasks or recovery were blocked:** confirm both Dida snapshot requests are available, then run sync again. The block protects unbound todos from duplicate creation.
- **Recovery reports an ambiguous source marker:** find the Dida tasks that share the displayed `SiYuan-Block-ID:` value and resolve the duplicate manually. The plugin will not choose one silently.
- **Settings report an invalid configuration:** correct every missing, duplicate, or overlapping range and save before syncing again.
- **Another computer does not work:** install and authorize the CLI separately on that computer. Do not copy CLI paths or authorization files between devices.

## Limits

This MVP does not delete tasks, sync due dates or reminders, sync repeating tasks, synchronize Dida title edits back to SiYuan, or synchronize tables and database blocks. The new-task date setting affects only tasks created after the setting is saved; it never changes dates on existing Dida tasks.

The Dida CLI does not provide a remote idempotency primitive for task creation. Do not run simultaneous initial syncs for the same unbound SiYuan todos on multiple devices. Cross-device exactly-once creation is not guaranteed; if duplicates are created, their matching source markers become ambiguous and the plugin stops recovery safely instead of choosing a task.

## Development

```sh
npm test
npm run typecheck
npm run build
npm run package
```

`npm run package` creates `package.zip` for a GitHub Release.
