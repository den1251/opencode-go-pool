import { Rpc } from "@opencode/plugin/rpc"

const empty = { type: "object", properties: {}, additionalProperties: false } as const
const status = { type: "object", additionalProperties: true } as const

export const GoPool = Rpc.define({
  id: "opencode-go-pool",
  methods: {
    status: { input: empty, output: status },
    refresh: { input: empty, output: status },
  },
  events: {},
})
