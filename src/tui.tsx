import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { For, createSignal } from "solid-js"
import { usageLines } from "./format"
import { GoPool } from "./rpc"
import type { Status } from "./types"

function defineStatus(use: Context) {
  const [status, setStatus] = createSignal<Status>()
  let disposed = false
  const load = async () => {
    try {
      const value = (await use.client.rpc(GoPool).status({})) as Status
      if (!disposed) setStatus(value)
    } catch {
      // The dialog shows a loading line until the server part answers.
    }
  }

  const UsageDialog = () => (
    <box
      flexDirection="column"
      padding={1}
      border
      borderStyle="rounded"
      borderColor={use.theme.border.base.rgba}
      backgroundColor={use.theme.background.base.rgba}
      title="OpenCode Go Pool"
    >
      <For each={usageLines(status())}>{(line) => <text>{line || " "}</text>}</For>
    </box>
  )

  const openUsage = () => {
    void load()
    use.ui.dialog.set({ size: "xlarge", centered: true })
    use.ui.dialog.show(() => <UsageDialog />)
  }

  return { load, openUsage, dispose: () => (disposed = true) }
}

export default Plugin.define({
  id: "opencode-go-pool.tui",
  async setup(ctx) {
    const { load, openUsage, dispose } = defineStatus(ctx)

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-go-pool.usage",
          title: "Go pool usage",
          group: "Go Pool",
          palette: true,
          slash: { name: "go-pool" },
          run: () => openUsage(),
        },
      ],
    }))

    return () => {
      dispose()
    }
  },
})
