// src/tui.tsx
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { For, createSignal } from "solid-js";

// src/format.ts
function money(value) {
  if (!Number.isFinite(value) || value === 0)
    return "$0.00";
  if (value < 0.01)
    return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
function percent(window) {
  return window ? `${Math.round(window.percent)}%` : "—";
}
function quotaLine(account) {
  if (!account)
    return "no account";
  const quota = account.quota;
  return `5h ${percent(quota?.rolling)} · week ${percent(quota?.weekly)} · month ${percent(quota?.monthly)}`;
}
function activeAccount(status) {
  return status?.accounts.find((account) => account.active) ?? status?.accounts[0];
}
function planText(value) {
  return value > 0 ? `plan ${money(value)}` : "plan n/a";
}
function modelLine(model) {
  const name = (model.modelName ?? model.model).padEnd(24).slice(0, 24);
  return `${name} ${String(model.requests).padStart(7)} ${money(model.cost).padStart(9)} ${money(model.allowance).padStart(9)}`;
}
function modelHeader() {
  return `${"Model".padEnd(24)} ${"Req".padStart(7)} ${"List $".padStart(9)} ${"Plan $".padStart(9)}`;
}
function usageLines(status) {
  if (!status)
    return ["Loading OpenCode Go usage…"];
  const account = activeAccount(status);
  const lines = [
    `OpenCode Go Pool — ${status.accounts.length} account(s)`,
    `Active: ${account ? `${account.label} (${account.keyHint})` : "none"}`,
    `Quota: ${quotaLine(account)}`,
    `Today: ${money(status.today.cost)} list · ${planText(status.today.allowance)} · ${status.today.entries} request(s)`,
    `Month: ${money(status.month.cost)} list · ${planText(status.month.allowance)} · ${status.month.entries} request(s)`
  ];
  if (status.today.models.length > 0) {
    lines.push("", "Models today", modelHeader());
    for (const model of status.today.models)
      lines.push(modelLine(model));
  }
  if (status.month.models.length > 0) {
    lines.push("", "Models this month", modelHeader());
    for (const model of status.month.models)
      lines.push(modelLine(model));
  }
  if (status.month.estimated > 0) {
    lines.push("", `Cost includes catalog estimates for ${status.month.estimated} request(s).`);
  }
  return lines;
}

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var empty = { type: "object", properties: {}, additionalProperties: false };
var status = { type: "object", additionalProperties: true };
var GoPool = Rpc.define({
  id: "opencode-go-pool",
  methods: {
    status: { input: empty, output: status },
    refresh: { input: empty, output: status }
  },
  events: {}
});

// src/tui.tsx
function defineStatus(use) {
  const [status, setStatus] = createSignal();
  let disposed = false;
  const load = async () => {
    try {
      const value = await use.client.rpc(GoPool).status({});
      if (!disposed)
        setStatus(value);
    } catch {}
  };
  const UsageDialog = () => (() => {
    var _el$ = _$createElement("box");
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "padding", 1);
    _$setProp(_el$, "border", true);
    _$setProp(_el$, "borderStyle", "rounded");
    _$setProp(_el$, "title", "OpenCode Go Pool");
    _$insert(_el$, _$createComponent(For, {
      get each() {
        return usageLines(status());
      },
      children: (line) => (() => {
        var _el$2 = _$createElement("text");
        _$insert(_el$2, line || " ");
        return _el$2;
      })()
    }));
    _$effect((_p$) => {
      var _v$ = use.theme.border.base.rgba, _v$2 = use.theme.background.base.rgba;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "borderColor", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$, "backgroundColor", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$;
  })();
  const openUsage = () => {
    load();
    use.ui.dialog.set({
      size: "xlarge",
      centered: true
    });
    use.ui.dialog.show(() => _$createComponent(UsageDialog, {}));
  };
  return {
    load,
    openUsage,
    dispose: () => disposed = true
  };
}
var tui_default = Plugin.define({
  id: "opencode-go-pool.tui",
  async setup(ctx) {
    const {
      load,
      openUsage,
      dispose
    } = defineStatus(ctx);
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "opencode-go-pool.usage",
        title: "Go pool usage",
        group: "Go Pool",
        palette: true,
        slash: {
          name: "go-pool"
        },
        run: () => openUsage()
      }]
    }));
    return () => {
      dispose();
    };
  }
});
export {
  tui_default as default
};
