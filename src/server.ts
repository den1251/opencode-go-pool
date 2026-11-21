import { appendFile, rename, stat } from "node:fs/promises"
import type { Rpc } from "@opencode/plugin/rpc"
import type { RpcHandlers } from "@opencode/plugin/promise/rpc"
import type { Aggregate, Account, AccountState, CooldownCache, PluginOptions, QuotaCache, QuotaSnapshot, Status, SwitchEntry, Tokens, UsageEntry } from "./types"
import { applyAuthorization } from "./auth"
import { readCooldowns, readQuotaCache, writeCooldown, writeQuotaCache } from "./cache-store"
import { clearUsage } from "./clear"
import { estimateCost, type PricingTier } from "./pricing"
import { dataDirectory, DEFAULT_UPSTREAM, paths, settings } from "./config"
import { discoverAccounts, type DiscoveryContext } from "./discovery"
import { startDashboard, type Dashboard } from "./dashboard"
import { ensureDir, readJson, withLock, writeJsonAtomic } from "./fs-utils"
import { resolveOwner } from "./identity"
import { resolveMachine } from "./machine"
import { aggregateUsage, applyEntry, dayKey, monthKey, normalizeTokens, pruneUsage, recordUsage } from "./ledger"
import { fetchQuota, limitingReset, nextReset, quotaFresh } from "./quota"
import { selectAccount } from "./selection"
import { appendSwitch, buildStatus, readSwitches, writeStatus } from "./status"
import { loadAccountState, reconcileAccounts, setActiveAccount } from "./state-store"
import { readResponseUsage, type RawUsage } from "./usage"
import { GoPool } from "./rpc"

interface Registration {
  dispose(): Promise<void>
}

interface PluginContext extends DiscoveryContext {
  options?: unknown
  event: {
    subscribe(options?: { types?: string[] }): AsyncIterable<PluginEvent>
  }
  session: {
    hook(
      name: "http.request",
      callback: (input: HttpRequestInput) => Promise<void> | void,
      options?: { providerID?: string },
    ): Promise<Registration>
    hook(
      name: "http.response",
      callback: (input: HttpResponseInput) => Promise<void> | void,
      options?: { providerID?: string },
    ): Promise<Registration>
  }
  model: {
    list(input?: unknown): Promise<{ data: ModelInfo[] }>
  }
  rpc?: {
    register<D extends Rpc.PortableDefinition>(definition: D, handlers: RpcHandlers<D>): Promise<Registration>
  }
}

interface PluginEvent {
  id: string
  created: number
  type: string
  data: Record<string, unknown>
}

interface HttpRequestInput {
  sessionID: string
  agent: string
  model: { id: string; providerID: string }
  kind: string
  request: Request
}

interface HttpResponseInput extends HttpRequestInput {
  response: Response
}

interface ModelInfo {
  id: string
  providerID: string
  name?: string
  cost: PricingTier[]
}

interface RequestContext {
  accountID: string
  accountLabel: string
  providerID: string
  modelID: string
  sessionID: string
  kind: string
  at: number
  exhausted: boolean
  template?: Request
}

interface LastUse {
  accountID: string
  providerID: string
  modelID: string
  kind: string
  at: number
}

interface PendingUsage {
  sessionID: string
  kind: string
  accountID: string
  accountLabel: string
  providerID: string
  modelID: string
  at: number
  usage: Promise<RawUsage | undefined>
}

interface DirectoryState {
  lastBySession: Map<string, LastUse>
  pendingUsage: PendingUsage[]
  requestContexts: WeakMap<Request, RequestContext>
  processedEvents: Map<string, number>
}

const SHARED_STATE_KEY = "__opencodeGoPoolSharedStateV1"

function sharedState(directory: string): DirectoryState {
  const holder = globalThis as typeof globalThis & {
    [SHARED_STATE_KEY]?: Map<string, DirectoryState>
  }
  const states = (holder[SHARED_STATE_KEY] ??= new Map<string, DirectoryState>())
  const existing = states.get(directory)
  if (existing) {
    existing.lastBySession ??= new Map()
    existing.pendingUsage ??= []
    existing.requestContexts ??= new WeakMap()
    existing.processedEvents ??= new Map()
    return existing
  }
  const created: DirectoryState = {
    lastBySession: new Map(),
    pendingUsage: [],
    requestContexts: new WeakMap(),
    processedEvents: new Map(),
  }
  states.set(directory, created)
  return created
}

const PLUGIN_ID = "opencode-go-pool"
const PROVIDER_ID = "opencode-go"
const DASHBOARDS_KEY = "__opencodeGoPoolDashboardsV1"

function dashboardRegistry() {
  const holder = globalThis as typeof globalThis & {
    [DASHBOARDS_KEY]?: Map<string, { dashboard: Dashboard; refs: number }>
  }
  return (holder[DASHBOARDS_KEY] ??= new Map<string, { dashboard: Dashboard; refs: number }>())
}

export default {
  id: PLUGIN_ID,
  async setup(ctx: PluginContext) {
    const options = (ctx.options ?? {}) as PluginOptions
    const directory = dataDirectory(options)
    const files = paths(directory)
    const config = settings(options)
    await ensureDir(directory)
    await ensureDir(files.events)

    const logger = createLogger(files.log, config.debug)
    const shared = sharedState(directory)
    const requestContexts = shared.requestContexts
    const lastBySession = shared.lastBySession
    const pendingUsage = shared.pendingUsage
    const processedEvents = shared.processedEvents
    const pricing = new Map<string, PricingTier[]>()
    const modelNames = new Map<string, string>()
    let pricingAt = 0
    const inFlight = new Map<string, Promise<QuotaSnapshot>>()
    const registrations: Registration[] = []
    const dashboardRef: { value: Dashboard | undefined } = { value: undefined }
    let dashboardEntry: { dashboard: Dashboard; refs: number } | undefined
    let stopped = false
    let accounts: Account[] = []
    let state: AccountState = { version: 1, order: [], disabled: [], updatedAt: 0 }
    let quotas: QuotaCache = await readQuotaCache(files.quota)
    let cooldowns: CooldownCache = await readCooldowns(files.cooldown)
    let switches: SwitchEntry[] = await readSwitches(files.switches)
    let aggregates = await loadAggregates()
    let lastError: string | undefined
    let owner = await resolveOwner(directory, config.owner)
    let ownerAt = Date.now()
    const machineID = await resolveMachine(directory)
    let statusTimer: ReturnType<typeof setTimeout> | undefined
    let statusDue = Number.POSITIVE_INFINITY
    let discoveryTimer: ReturnType<typeof setTimeout> | undefined
    let discoveryAttempt = 0
    let lastReloadAt = 0
    let eventIterator: AsyncIterator<PluginEvent> | undefined
    let eventLoop: Promise<void> | undefined

    async function loadAggregates() {
      const now = Date.now()
      const [today, month] = await Promise.all([
        aggregateUsage(files.events, { day: dayKey(now) }),
        aggregateUsage(files.events, { month: monthKey(now) }),
      ])
      return { at: now, day: dayKey(now), monthKey: monthKey(now), today, month }
    }

    async function loadPricing(force = false) {
      if (!force && Date.now() - pricingAt < 5 * 60_000) return
      try {
        const result = await ctx.model.list()
        for (const model of result.data) {
          if (model.providerID !== PROVIDER_ID) continue
          pricing.set(model.id, model.cost)
          if (model.name) modelNames.set(model.id, model.name)
        }
        pricingAt = Date.now()
      } catch (error) {
        logger.error("failed to load model pricing", error)
      }
    }

    async function modelNameFor(modelID: string) {
      if (!modelNames.has(modelID)) await loadPricing()
      return modelNames.get(modelID)
    }

    async function estimatedCostFor(modelID: string, tokens: Tokens) {
      if (pricing.size === 0 || !pricing.has(modelID)) await loadPricing()
      return estimateCost(pricing.get(modelID), tokens)
    }

    function scheduleStatus(delay = 250) {
      if (stopped) return
      const due = Date.now() + delay
      if (statusTimer && statusDue <= due) return
      if (statusTimer) clearTimeout(statusTimer)
      statusDue = due
      statusTimer = setTimeout(() => {
        statusTimer = undefined
        statusDue = Number.POSITIVE_INFINITY
        void writeCurrentStatus().catch((error) => logger.error("failed to write status", error))
      }, delay)
      statusTimer.unref?.()
    }

    async function currentOwner() {
      if (Date.now() - ownerAt < 5000) return owner
      owner = await resolveOwner(directory, config.owner)
      ownerAt = Date.now()
      return owner
    }

    function makeStatus(): Status {
      return buildStatus({
        dataDir: directory,
        owner,
        machineID,
        accounts,
        state,
        quotas,
        cooldowns,
        today: aggregates.today,
        month: aggregates.month,
        switches,
        ...(dashboardRef.value ? { dashboard: { url: dashboardRef.value.url, port: dashboardRef.value.port } } : {}),
        threshold: config.switchAtPercent,
        ...(lastError ? { lastError } : {}),
      })
    }

    async function writeCurrentStatus() {
      const marker = await readJson<{ at?: number }>(files.clearRequest)
      let reload =
        (typeof marker?.at === "number" && marker.at > aggregates.at) || Date.now() - aggregates.at > 3000
      if (!reload) {
        try {
          reload = (await stat(files.events)).mtimeMs > aggregates.at
        } catch {
          reload = false
        }
      }
      if (reload) aggregates = await loadAggregates()
      await writeStatus(files.status, makeStatus())
    }

    async function currentStatus() {
      if (Date.now() - aggregates.at > 3000) aggregates = await loadAggregates()
      await currentOwner()
      return makeStatus()
    }

    async function registerRpc() {
      if (!ctx.rpc) return
      try {
        const registration = await ctx.rpc.register(GoPool, {
          status: async () => currentStatus(),
          refresh: async () => {
            await refreshAll(true)
            aggregates = await loadAggregates()
            await writeCurrentStatus()
            return currentStatus()
          },
        })
        registrations.push(registration)
      } catch (error) {
        logger.warn("failed to register RPC", error)
      }
    }

    async function refreshQuota(account: Account, force = false) {
      const cached = quotas.accounts[account.id]
      if (!force && cached && quotaFresh(cached, config.refreshSeconds)) return cached
      const pending = inFlight.get(account.id)
      if (pending) return pending
      const task = fetchQuota(account, {
        usageURL: config.usageURL,
        timeoutMs: config.requestTimeoutMs,
      })
        .then(async (snapshot) => {
          quotas.accounts[account.id] = snapshot
          await writeQuotaCache(files.quota, directory, quotas).catch((error) =>
            logger.error("failed to persist quota cache", error),
          )
          scheduleStatus()
          return snapshot
        })
        .finally(() => inFlight.delete(account.id))
      inFlight.set(account.id, task)
      return task
    }

    async function refreshAll(force = true) {
      for (const account of accounts) {
        await refreshQuota(account, force)
      }
    }

    async function reloadAccounts() {
      if (stopped) return
      try {
        const discovered = await discoverAccounts(ctx)
        accounts = discovered
        lastReloadAt = Date.now()
        if (accounts.length === 0) {
          const ids = await integrationIDs()
          logger.info("no OpenCode Go connections found yet", {
            integrations: ids.filter((id) => id === "opencode" || id === "opencode-go"),
          })
          if (discoveryAttempt < 8) {
            const delay = Math.min(30_000, 100 * 2 ** discoveryAttempt)
            discoveryAttempt += 1
            scheduleDiscovery(delay)
          }
        } else {
          discoveryAttempt = 0
        }
        state = await reconcileAccounts(files.accounts, directory, accounts)
        scheduleStatus(50)
        void refreshAll(true).catch((error) => logger.error("failed to refresh quotas", error))
      } catch (error) {
        logger.error("failed to discover accounts", error)
      }
    }

    async function integrationIDs() {
      try {
        const result = await ctx.integration.list()
        return (result.data ?? []).map((item) => item.id)
      } catch {
        return []
      }
    }

    function scheduleDiscovery(delay = 150) {
      if (stopped) return
      if (discoveryTimer) clearTimeout(discoveryTimer)
      discoveryTimer = setTimeout(() => {
        discoveryTimer = undefined
        void reloadAccounts()
      }, delay)
      discoveryTimer.unref?.()
    }

    async function select(exclude?: ReadonlySet<string>) {
      const current = (await loadAccountState(files.accounts)) ?? state
      state = current
      const result = await selectAccount({
        accounts,
        state,
        quotas,
        cooldowns,
        threshold: config.switchAtPercent,
        ...(exclude ? { exclude } : {}),
        ensureQuota: (account) => refreshQuota(account),
      })
      if (result.account && result.changed) {
        state = await setActiveAccount(files.accounts, directory, result.account.id)
        const from = accounts.find((item) => item.id === result.previousID)
        const entry: SwitchEntry = {
          ts: Date.now(),
          from: from?.label ?? null,
          to: result.account.label,
          reason: result.reason,
        }
        switches = [...switches, entry]
        await appendSwitch(files.switches, entry).catch((error) => logger.error("failed to persist switch", error))
        logger.info(`switched to ${result.account.label}`, { reason: result.reason })
        scheduleStatus(30)
      }
      if (result.account) lastError = undefined
      else if (accounts.length > 0) lastError = "all OpenCode Go accounts are exhausted"
      return result
    }

    function applyHeaders(headers: Headers, account: Account) {
      applyAuthorization(headers, account)
    }

    async function onRequest(input: HttpRequestInput) {
      if (stopped) return
      if (accounts.some((account) => account.expires !== undefined && account.expires < Date.now() + 5 * 60_000)) {
        if (Date.now() - lastReloadAt > 30_000) await reloadAccounts()
      }
      let selection = await select()
      let account = selection.account
      let exhausted = false
      if (!account) {
        const fallback = accounts.find((item) => item.id === state.activeID) ?? accounts[0]
        if (!fallback) {
          requestContexts.set(input.request, {
            accountID: "none",
            accountLabel: "none",
            providerID: input.model.providerID,
            modelID: input.model.id,
            sessionID: input.sessionID,
            kind: input.kind,
            at: Date.now(),
            exhausted: true,
          })
          return
        }
        account = fallback
        exhausted = true
      }

      const headers = new Headers(input.request.headers)
      applyHeaders(headers, account)
      const url = rewriteURL(input.request.url, config.upstream)
      let next: Request
      try {
        next = rebuildRequest(input.request, url, headers)
      } catch (error) {
        logger.error("failed to rewrite request", error)
        return
      }
      let template: Request | undefined
      try {
        template = next.clone()
      } catch {
        template = undefined
      }
      requestContexts.set(next, {
        accountID: account.id,
        accountLabel: account.label,
        providerID: input.model.providerID,
        modelID: input.model.id,
        sessionID: input.sessionID,
        kind: input.kind,
        at: Date.now(),
        exhausted,
        ...(template ? { template } : {}),
      })
      input.request = next
    }

    async function onResponse(input: HttpResponseInput) {
      if (stopped) return
      const context = requestContexts.get(input.request)
      if (!context) return
      if (context.accountID === "none") {
        input.response = exhaustedResponse(null, accounts.length)
        return
      }

      if (input.response.ok) {
        captureUsage(input.response, context)
        commitUse(context)
        void refreshQuotaIfStale(context.accountID)
        return
      }
      if (![401, 403, 429].includes(input.response.status)) return

      const attempted = new Set<string>([context.accountID])
      let response = input.response
      await markFailure(context, response)

      while (!stopped && attempted.size < accounts.length) {
        const selection = await select(attempted)
        if (!selection.account) break
        attempted.add(selection.account.id)
        const template = context.template
        if (!template) break
        const retryHeaders = new Headers(template.headers)
        applyHeaders(retryHeaders, selection.account)
        let retry: Request
        try {
          retry = rebuildRequest(template.clone(), template.url, retryHeaders)
        } catch (error) {
          logger.error("failed to build retry request", error)
          break
        }
        let retryResponse: Response
        try {
          retryResponse = await fetch(retry, { signal: AbortSignal.timeout(60_000) })
        } catch (error) {
          logger.error("retry request failed", error)
          break
        }
        if (retryResponse.ok) {
          const retryContext = { ...context, accountID: selection.account.id, accountLabel: selection.account.label }
          captureUsage(retryResponse, retryContext)
          await cancelBody(response)
          input.response = retryResponse
          commitUse(retryContext)
          void refreshQuotaIfStale(selection.account.id, true)
          return
        }
        if (![401, 403, 429].includes(retryResponse.status)) {
          await cancelBody(response)
          input.response = retryResponse
          return
        }
        await markFailure({ ...context, accountID: selection.account.id, accountLabel: selection.account.label }, retryResponse)
        await cancelBody(response)
        response = retryResponse
      }

      const reset = nextReset(quotas.accounts[state.activeID ?? ""])
      input.response = exhaustedResponse(reset, attempted.size)
      lastError = "all OpenCode Go accounts are exhausted"
      scheduleStatus(30)
    }

    async function refreshQuotaIfStale(accountID: string, force = false) {
      const account = accounts.find((item) => item.id === accountID)
      if (!account) return
      if (!force && quotaFresh(quotas.accounts[accountID], config.refreshSeconds)) return
      await refreshQuota(account, force).catch((error) => logger.error("failed to refresh quota", error))
    }

    async function markFailure(context: RequestContext, response: Response) {
      const now = Date.now()
      if (response.status === 429) {
        const account = accounts.find((item) => item.id === context.accountID)
        if (account) await refreshQuota(account, true).catch(() => {})
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"), now)
        const until = limitingReset(quotas.accounts[context.accountID], now) ?? retryAfter ?? now + 5 * 60_000
        cooldowns = await writeCooldown(files.cooldown, directory, context.accountID, until)
        logger.warn(`account ${context.accountLabel} hit a quota limit`, { until })
      } else {
        cooldowns = await writeCooldown(files.cooldown, directory, context.accountID, now + 15 * 60_000)
        lastError = `${context.accountLabel} rejected the request (${response.status})`
        logger.warn(`account ${context.accountLabel} rejected the request`, { status: response.status })
      }
      scheduleStatus(30)
    }

    function commitUse(context: RequestContext) {
      lastBySession.set(context.sessionID, {
        accountID: context.accountID,
        providerID: context.providerID,
        modelID: context.modelID,
        kind: context.kind,
        at: Date.now(),
      })
      if (lastBySession.size > 500) {
        const cutoff = Date.now() - 6 * 60 * 60_000
        for (const [key, value] of lastBySession) if (value.at < cutoff) lastBySession.delete(key)
      }
    }

    function captureUsage(response: Response, context: RequestContext) {
      let clone: Response
      try {
        clone = response.clone()
      } catch {
        return
      }
      pendingUsage.push({
        sessionID: context.sessionID,
        kind: context.kind,
        accountID: context.accountID,
        accountLabel: context.accountLabel,
        providerID: context.providerID,
        modelID: context.modelID,
        at: Date.now(),
        usage: readResponseUsage(clone).catch((error) => {
          logger.error("failed to read usage from response", error)
          return undefined
        }),
      })
      if (pendingUsage.length > 500) pendingUsage.splice(0, pendingUsage.length - 500)
    }

    function claimEvent(id: string) {
      if (processedEvents.has(id)) return false
      processedEvents.set(id, Date.now())
      if (processedEvents.size > 5000) {
        const oldest = processedEvents.keys().next().value
        if (oldest !== undefined) processedEvents.delete(oldest)
      }
      return true
    }

    async function takeUsage(sessionID: string, kind: string, modelID?: string) {
      if (pendingUsage.length === 0) return undefined
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const exact = pendingUsage.findIndex(
          (item) => item.sessionID === sessionID && item.kind === kind && (!modelID || item.modelID === modelID),
        )
        const index = exact >= 0 ? exact : pendingUsage.findIndex((item) => item.sessionID === sessionID && item.kind === kind)
        if (index >= 0) {
          const item = pendingUsage[index]
          if (!item) return undefined
          pendingUsage.splice(index, 1)
          const usage = await Promise.race([
            item.usage,
            new Promise<undefined>((resolve) => {
              const timer = setTimeout(() => resolve(undefined), 3000)
              timer.unref?.()
            }),
          ]).catch(() => undefined)
          return { ...item, usage }
        }
        await delay(50)
      }
      return undefined
    }

    async function handleEvent(event: PluginEvent) {
      if (stopped) return
      if (event.type === "credential.updated" || event.type === "credential.switched" || event.type === "integration.updated") {
        scheduleDiscovery()
        return
      }
      if (event.type === "model.updated") {
        pricingAt = 0
        void loadPricing(true)
        return
      }
      if (event.type === "session.step.ended") {
        await recordStep(event)
      }
    }

    async function recordStep(event: PluginEvent) {
      const data = event.data
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : ""
      if (!sessionID) return
      if (!claimEvent(event.id)) return
      const last = lastBySession.get(sessionID)
      const modelID =
        isRecord(data.model) && typeof data.model.id === "string"
          ? data.model.id
          : last?.modelID
      const taken = await takeUsage(sessionID, "primary", modelID)
      const providerID =
        isRecord(data.model) && typeof data.model.providerID === "string"
          ? data.model.providerID
          : taken?.providerID ?? last?.providerID ?? PROVIDER_ID
      if (providerID !== PROVIDER_ID) return
      await saveUsage({
        id: event.id,
        ts: typeof event.created === "number" ? event.created : Date.now(),
        source: "step",
        sessionID,
        providerID,
        modelID: modelID ?? taken?.modelID ?? last?.modelID ?? "unknown",
        accountID: taken?.accountID ?? last?.accountID ?? "unattributed",
        tokens: normalizeTokens(data.tokens),
        reported: data.cost,
        raw: taken?.usage,
      })
    }

    async function saveUsage(input: {
      id: string
      ts: number
      source: string
      sessionID: string
      providerID: string
      modelID: string
      accountID: string
      tokens: Tokens
      reported?: unknown
      raw?: RawUsage
    }) {
      const account = accounts.find((item) => item.id === input.accountID)
      const tokens = input.raw?.tokens ? { ...input.tokens, ...input.raw.tokens } : input.tokens
      const reported =
        typeof input.reported === "number" && Number.isFinite(input.reported) ? Math.max(0, input.reported) : undefined
      const charged = input.raw?.charged ?? reported
      const listCost = input.raw?.listCost
      const modelName = await modelNameFor(input.modelID)
      const estimate =
        listCost === undefined && (charged === undefined || charged === 0) ? await estimatedCostFor(input.modelID, tokens) : 0
      const cost = listCost ?? (charged !== undefined && charged > 0 ? charged : estimate)
      const metering: UsageEntry["metering"] =
        listCost !== undefined ? "response" : charged !== undefined && charged > 0 ? "event" : "estimate"
      const entry: UsageEntry = {
        id: input.id,
        ts: input.ts,
        day: dayKey(input.ts),
        owner: await currentOwner(),
        machineID,
        accountID: input.accountID,
        accountLabel: account?.label ?? "unattributed",
        providerID: input.providerID,
        model: input.modelID,
        ...(modelName ? { modelName } : {}),
        source: input.source,
        cost,
        estimated: metering === "estimate" && estimate > 0,
        tokens,
        sessionID: input.sessionID,
        ...(listCost !== undefined ? { listCost } : {}),
        ...(input.raw?.allowance !== undefined ? { allowance: input.raw.allowance } : {}),
        ...(charged !== undefined ? { charged } : {}),
        ...(input.raw?.billingSource ? { billingSource: input.raw.billingSource } : {}),
        metering,
      }
      const created = await recordUsage(files.events, entry)
      if (!created) return
      const now = Date.now()
      if (entry.day !== aggregates.day || monthKey(now) !== aggregates.monthKey) {
        aggregates = await loadAggregates()
      } else {
        applyEntry(aggregates.today, entry)
        applyEntry(aggregates.month, entry)
      }
      scheduleStatus()
    }

    function startEventLoop() {
      const iterable = ctx.event.subscribe({
        types: [
          "session.step.ended",
          "credential.updated",
          "credential.switched",
          "integration.updated",
          "model.updated",
        ],
      })
      eventIterator = iterable[Symbol.asyncIterator]()
      eventLoop = (async () => {
        while (!stopped) {
          const next = await eventIterator?.next()
          if (!next || next.done) break
          await handleEvent(next.value).catch((error) => logger.error("failed to handle event", error))
        }
      })().catch((error) => {
        if (!stopped) logger.error("event subscription failed", error)
      })
    }

    async function registerHooks() {
      const request = await ctx.session.hook("http.request", onRequest, { providerID: PROVIDER_ID })
      registrations.push(request)
      const response = await ctx.session.hook("http.response", onResponse, { providerID: PROVIDER_ID })
      registrations.push(response)
    }

    async function startDashboardIfEnabled() {
      if (!config.dashboard) return
      const dashboards = dashboardRegistry()
      const existing = dashboards.get(directory)
      if (existing) {
        existing.refs += 1
        dashboardEntry = existing
        dashboardRef.value = existing.dashboard
        return
      }
      try {
        const dashboard = await startDashboard({
          port: config.dashboardPort,
          getStatus: async () => {
            if (Date.now() - aggregates.at > 3000) aggregates = await loadAggregates()
            await currentOwner()
            return makeStatus()
          },
          refresh: async () => {
            await refreshAll(true)
            aggregates = await loadAggregates()
            await writeCurrentStatus()
          },
          clear: async (filter) => {
            const result = await clearUsage(files.events, filter)
            aggregates = await loadAggregates()
            await writeCurrentStatus()
            return result
          },
        })
        dashboardEntry = { dashboard, refs: 1 }
        dashboards.set(directory, dashboardEntry)
        dashboardRef.value = dashboard
        await writeJsonAtomic(
          files.dashboard,
          {
            url: dashboard.url,
            port: dashboard.port,
            token: dashboard.token,
            pid: process.pid,
          },
          0o600,
        )
        logger.info(`dashboard listening on ${dashboard.url}`)
      } catch (error) {
        logger.error("failed to start dashboard", error)
      }
    }

    try {
      await loadPricing()
      await pruneUsage(files.events).catch(() => {})
      await reloadAccounts()
      if (accounts.length === 0) logger.warn("no OpenCode Go connections found yet")
      await registerHooks()
      await registerRpc()
      await startDashboardIfEnabled()
      startEventLoop()
      await writeCurrentStatus().catch((error) => logger.error("failed to write initial status", error))
    } catch (error) {
      logger.error("setup failed", error)
    }

    return async () => {
      stopped = true
      if (statusTimer) clearTimeout(statusTimer)
      if (discoveryTimer) clearTimeout(discoveryTimer)
      await eventIterator?.return?.().catch(() => {})
      await eventLoop?.catch(() => {})
      for (const registration of registrations) await registration.dispose().catch(() => {})
      if (dashboardEntry) {
        dashboardEntry.refs -= 1
        if (dashboardEntry.refs <= 0) {
          dashboardRegistry().delete(directory)
          await dashboardEntry.dashboard.close().catch(() => {})
          const current = await readJson<{ pid?: number }>(files.dashboard)
          if (current?.pid === process.pid) {
            await withLock(directory, "dashboard-file", () => writeJsonAtomic(files.dashboard, {})).catch(() => {})
          }
        }
      }
      await writeCurrentStatus().catch(() => {})
      logger.info("stopped")
    }
  },
}

function rewriteURL(url: string, upstream: string) {
  if (upstream === DEFAULT_UPSTREAM) return url
  const source = new URL(url)
  const base = new URL(DEFAULT_UPSTREAM)
  if (source.origin !== base.origin) return url
  return new URL(source.pathname + source.search, upstream).toString()
}

function rebuildRequest(base: Request, url: string, headers: Headers) {
  const method = base.method.toUpperCase()
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    redirect: base.redirect,
    signal: base.signal,
  }
  if (method !== "GET" && method !== "HEAD") {
    init.body = base.body
    init.duplex = "half"
  }
  return new Request(url, init)
}

async function cancelBody(response: Response) {
  try {
    await response.body?.cancel()
  } catch {}
}

function parseRetryAfter(value: string | null, now: number) {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? date : undefined
}

function exhaustedResponse(reset: number | null, attempts: number) {
  const when = reset ? new Date(reset).toLocaleString() : "unknown"
  return Response.json(
    {
      error: {
        message: `All ${attempts} OpenCode Go account(s) are exhausted. Next quota reset: ${when}.`,
        type: "go_pool_exhausted",
      },
    },
    { status: 429 },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function createLogger(file: string, debug: boolean) {
  const write = (level: string, message: string, extra?: unknown) => {
    const suffix = extra === undefined ? "" : ` ${serialize(extra)}`
    const line = `${new Date().toISOString()} ${level} ${message}${suffix}\n`
    if (debug) console.error(line.trimEnd())
    void (async () => {
      try {
        const info = await stat(file).catch(() => undefined)
        if (info && info.size > 2_000_000) await rename(file, `${file}.1`).catch(() => {})
        await appendFile(file, line, { mode: 0o600 })
      } catch {}
    })()
  }
  return {
    info: (message: string, extra?: unknown) => write("INFO", message, extra),
    warn: (message: string, extra?: unknown) => write("WARN", message, extra),
    error: (message: string, error?: unknown) => write("ERROR", message, error),
  }
}

function serialize(value: unknown) {
  if (value instanceof Error) return JSON.stringify({ message: value.message })
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
