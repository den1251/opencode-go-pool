// node_modules/@opencode/schema/dist/rpc.js
function define(definition) {
  const reserved = Object.values(definition.methods).flatMap((method) => Object.keys(method.errors ?? {})).find((name) => name.startsWith("rpc."));
  if (reserved)
    throw new Error(`RPC error names starting with "rpc." are reserved: ${reserved}`);
  return definition;
}
// src/rpc.ts
var empty = { type: "object", properties: {}, additionalProperties: false };
var status = { type: "object", additionalProperties: true };
var GoPool = define({
  id: "opencode-go-pool",
  methods: {
    status: { input: empty, output: status },
    refresh: { input: empty, output: status }
  },
  events: {}
});
export {
  GoPool
};
