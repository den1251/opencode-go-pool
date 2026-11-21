/** @jsxImportSource solid-js */
import { Command, MenuItem, Panel, Plugin } from "@opencode/plugin/gui"
import type { Command as CommandSpec, MenuItem as MenuItemSpec, PanelTab } from "@opencode/plugin/gui"
import { For, createSignal, onCleanup } from "solid-js"
import { activeAccount, compact, money, percent, planValue, quotaLine } from "./format"
import { GoPool } from "./rpc"
import type { ModelUsage, Status } from "./types"

function menuDetail(status: Status | undefined) {
  const account = activeAccount(status)
  return account ? `5h ${percent(account.quota?.rolling)}` : "no quota"
}

const tab: PanelTab = {
  id: "usage",
  get title() {
    return "Go Pool"
  },
  closable: "compact",
}

function ModelSection(props: { title: string; models: ModelUsage[] }) {
  return (
    <div>
      <div style={{ "font-weight": "600", "margin-bottom": "4px" }}>{props.title}</div>
      <For each={props.models}>
        {(model) => (
          <div
            style={{
              display: "grid",
              "grid-template-columns": "1fr auto",
              gap: "2px 8px",
              padding: "4px 0",
              "border-bottom": "1px solid rgba(127,127,127,0.12)",
            }}
          >
            <span>{model.modelName ?? model.model}</span>
            <span style={{ opacity: 0.8 }}>{money(model.cost)} list</span>
            <span style={{ opacity: 0.6 }}>
              {model.requests} req · {compact(model.input)} in / {compact(model.output)} out
            </span>
            <span style={{ opacity: 0.6 }}>{planValue(model.allowance)}</span>
          </div>
        )}
      </For>
    </div>
  )
}

export default Plugin.define({
  i18n: {
    en: {
      title: "OpenCode Go Pool",
      usage: "Open Go pool usage",
      refresh: "Refresh quota",
    },
  },
  setup(ctx) {
    const [status, setStatus] = createSignal<Status>()
    let disposed = false

    const load = async () => {
      try {
        const value = (await ctx.client.rpc(GoPool).status({})) as Status
        if (!disposed) setStatus(value)
      } catch {
        // The panel shows the last snapshot once the server part answers.
      }
    }

    const refresh = async () => {
      try {
        const value = (await ctx.client.rpc(GoPool).refresh({})) as Status
        if (!disposed) setStatus(value)
      } catch {
        // Keep the last snapshot while the server is unavailable.
      }
    }

    const openPanel = () => {
      void load()
      const session = ctx.sessions.current()
      if (session) ctx.layout.open(`${ctx.id}:usage`, session)
    }

    function UsagePanel() {
      return (
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "12px",
            padding: "12px",
            height: "100%",
            "overflow-y": "auto",
            "font-size": "13px",
          }}
        >
          <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "8px" }}>
            <strong>OpenCode Go Pool</strong>
            <ctx.ui.Button size="small" variant="ghost" onClick={() => void refresh()}>
              Refresh
            </ctx.ui.Button>
          </div>
          <For each={status()?.accounts ?? []}>
            {(account) => (
              <div style={{ display: "flex", "justify-content": "space-between", gap: "12px" }}>
                <span>
                  {account.label}
                  {account.active ? " · active" : ""}
                </span>
                <span style={{ opacity: 0.7 }}>{quotaLine(account)}</span>
              </div>
            )}
          </For>
          <div style={{ "border-top": "1px solid rgba(127,127,127,0.2)", "padding-top": "8px" }}>
            <div>
              Today: {money(status()?.today.cost ?? 0)} list · {planValue(status()?.today.allowance ?? 0)} ·{" "}
              {status()?.today.entries ?? 0} req
            </div>
            <div>
              This month: {money(status()?.month.cost ?? 0)} list · {planValue(status()?.month.allowance ?? 0)} ·{" "}
              {status()?.month.entries ?? 0} req
            </div>
          </div>
          <ModelSection title="Models today" models={status()?.today.models ?? []} />
          <ModelSection title="Models this month" models={status()?.month.models ?? []} />
        </div>
      )
    }

    ctx.add(Panel, {
      id: "usage",
      region: "side",
      width: "narrow",
      list: (input) => (input.open.includes("usage") ? [tab] : []),
      render: () => <UsagePanel />,
    })

    ctx.add(MenuItem, (): MenuItemSpec => {
      const session = ctx.sessions.current()
      return {
        menu: "session.panel",
        id: "usage",
        title: ctx.t("usage"),
        description: status() ? menuDetail(status()) : undefined,
        icon: "status",
        opened: !!session && ctx.layout.state(`${ctx.id}:usage`, session) !== "closed",
        run: openPanel,
      }
    })

    ctx.add(Command, (): CommandSpec => ({
      id: "usage",
      title: ctx.t("usage"),
      group: "Go Pool",
      section: "session",
      slash: { name: "go-pool" },
      run: openPanel,
    }))

    onCleanup(() => {
      disposed = true
    })
  },
})
