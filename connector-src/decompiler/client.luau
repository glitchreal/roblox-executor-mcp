return function(dependencies)
local ScriptMappingPipeline = dependencies.ScriptMappingPipeline
local HttpService = dependencies.HttpService
local BridgeURL = dependencies.BridgeURL
local StripDecompilerBanner = dependencies.StripDecompilerBanner
local base64_encode = dependencies.base64_encode
local BuiltInDecompile = dependencies.BuiltInDecompile
local GetScriptHash = dependencies.GetScriptHash
local DecompilerAttemptState = dependencies.DecompilerAttemptState
local PreparedScript = dependencies.PreparedScript
local Concurrency = dependencies.Concurrency
local SourceCacheLookupBatchMax = 256
local ScriptHashTimeoutSeconds = 2
local BytecodeTimeoutSeconds = 3
local BuiltInDecompileTimeoutSeconds = 8
local ServerDecompileTimeoutSeconds = 65
local DecompilerPlan = {
    providerId = nil,
    expiresAt = 0,
    refreshToken = nil,
    blockedBuiltinUntil = 0,
}
local BuiltInObservations = {
    startedAt = nil,
    lastAt = nil,
    samples = 0,
    lastReportAt = 0,
    revision = 0,
}

local function RunWithTimeout(timeoutSeconds, callback)
    local completed = false
    local success = false
    local result = nil

    local worker = task.spawn(function()
        success, result = pcall(callback)
        completed = true
    end)

    local deadline = os.clock() + timeoutSeconds
    while not completed and os.clock() < deadline do
        task.wait(0.05)
    end

    if not completed then
        pcall(task.cancel, worker)
        return false, "Timed out after " .. tostring(timeoutSeconds) .. "s."
    end

    if not success then
        return false, result
    end

    return true, result
end

local function RememberScriptSourceForHash(scriptHash, source)
    if type(scriptHash) ~= "string" or scriptHash == "" then return false end
    if type(source) ~= "string" or source == "" then return false end

    ScriptMappingPipeline.sourceCacheByHash[scriptHash] = source
    ScriptMappingPipeline.sourceCacheCheckedByHash[scriptHash] = true
    return true
end

local function ReadScriptHash(script)
    if type(GetScriptHash) ~= "function" then return nil end

    local success, result = RunWithTimeout(ScriptHashTimeoutSeconds, function()
        return GetScriptHash(script)
    end)

    if not success or type(result) ~= "string" or result == "" then
        return nil
    end

    return result
end

local function GetScriptHashForInstance(script)
    local debugId = script:GetDebugId()
    if ScriptMappingPipeline.scriptHashByDebugId[debugId] ~= nil then
        return ScriptMappingPipeline.scriptHashByDebugId[debugId] or nil
    end

    local scriptHash = ReadScriptHash(script)
    ScriptMappingPipeline.scriptHashByDebugId[debugId] = scriptHash or false
    return scriptHash
end

local function FetchCachedScriptSourceBatch(clientId, hashesToFetch)
    if #hashesToFetch == 0 then return true end

    local ok, response = pcall(request, {
        Url = "http://" .. BridgeURL .. "/script-source-cache",
        Method = "POST",
        Headers = {
            ["Content-Type"] = "application/json",
            ["Accept"] = "application/json",
        },
        Body = HttpService:JSONEncode({
            clientId = clientId,
            hashes = hashesToFetch,
        }),
    })

    if not ok or type(response) ~= "table" or response.StatusCode ~= 200 or type(response.Body) ~= "string" then
        return false
    end

    local decodedOk, decoded = pcall(function()
        return HttpService:JSONDecode(response.Body)
    end)
    if not decodedOk or type(decoded) ~= "table" or type(decoded.sources) ~= "table" then
        return false
    end

    for _, item in ipairs(decoded.sources) do
        if type(item) == "table" then
            RememberScriptSourceForHash(item.scriptHash, item.source)
        end
    end

    return true
end

local function FetchCachedScriptSources(clientId, scriptHashes)
    if type(request) ~= "function" then return end
    if type(clientId) ~= "string" or clientId == "" then return end
    if type(scriptHashes) ~= "table" then return end

    local hashesToFetch = {}
    local seen = {}
    local function flush()
        local fetched = FetchCachedScriptSourceBatch(clientId, hashesToFetch)
        if fetched then
            for _, scriptHash in hashesToFetch do
                ScriptMappingPipeline.sourceCacheCheckedByHash[scriptHash] = true
            end
        end
        table.clear(hashesToFetch)
    end

    for _, scriptHash in ipairs(scriptHashes) do
        if (
            type(scriptHash) == "string" and
            scriptHash ~= "" and
            not ScriptMappingPipeline.sourceCacheByHash[scriptHash] and
            not ScriptMappingPipeline.sourceCacheCheckedByHash[scriptHash] and
            not seen[scriptHash]
        ) then
            seen[scriptHash] = true
            table.insert(hashesToFetch, scriptHash)
            if #hashesToFetch >= SourceCacheLookupBatchMax then
                flush()
            end
        end
    end

    flush()
end

local function ReadScriptBytecode(script)
    local success, bytecode = RunWithTimeout(BytecodeTimeoutSeconds, function()
        return getscriptbytecode(script)
    end)
    if not success or bytecode == nil then
        return false, bytecode or "Failed to read script bytecode."
    end
    return true, bytecode
end

local function TryBuiltInDecompile(script)
    if type(BuiltInDecompile) ~= "function" then
        return nil, 0, "Executor built-in decompile is unavailable.", false
    end

    local startedAt = os.clock()
    local success, source = RunWithTimeout(BuiltInDecompileTimeoutSeconds, function()
        return BuiltInDecompile(script)
    end)
    local latencyMs = math.floor((os.clock() - startedAt) * 1000)
    if not success then
        local errorMessage = tostring(source or "Built-in decompile failed.")
        return nil, latencyMs, errorMessage, string.find(errorMessage, "Timed out", 1, true) ~= nil
    end
    if type(source) ~= "string" or source == "" then
        return nil, latencyMs, "Built-in decompile returned no source.", false
    end

    return StripDecompilerBanner(source), latencyMs
end

local function IsActiveMappingContext(generation, clientId)
    return (
        generation == ScriptMappingPipeline.generation and
        clientId ~= nil and
        clientId == ScriptMappingPipeline.clientId
    )
end

local function RefreshDecompilerPlan(force, generation, clientId)
    generation = generation or ScriptMappingPipeline.generation
    clientId = clientId or ScriptMappingPipeline.clientId
    if not IsActiveMappingContext(generation, clientId) then return nil end
    local now = os.clock()
    if not force and DecompilerPlan.expiresAt > now then
        return DecompilerPlan.providerId
    end
    if DecompilerPlan.refreshToken then
        local deadline = now + 2
        repeat task.wait() until not DecompilerPlan.refreshToken or os.clock() >= deadline
        return DecompilerPlan.providerId
    end
    if type(request) ~= "function" then return nil end

    local refreshToken = {}
    DecompilerPlan.refreshToken = refreshToken

    local success, response = RunWithTimeout(5, function()
        return request({
            Url = "http://" .. BridgeURL .. "/decompile-plan?clientId=" .. HttpService:UrlEncode(clientId),
            Method = "GET",
            Headers = {
                ["Accept"] = "application/json",
            },
        })
    end)
    if DecompilerPlan.refreshToken ~= refreshToken then return nil end
    DecompilerPlan.refreshToken = nil
    if not IsActiveMappingContext(generation, clientId) then return nil end
    if not success or type(response) ~= "table" or response.StatusCode ~= 200 or type(response.Body) ~= "string" then
        DecompilerPlan.providerId = nil
        DecompilerPlan.expiresAt = now + 0.25
        return nil
    end

    local decodedOk, plan = pcall(function()
        return HttpService:JSONDecode(response.Body)
    end)
    if not decodedOk or type(plan) ~= "table" then
        DecompilerPlan.providerId = nil
        DecompilerPlan.expiresAt = now + 0.25
        return nil
    end

    DecompilerPlan.providerId = if type(plan.providerId) == "string" then plan.providerId else nil
    local ttlSeconds = math.max(0.25, math.min((tonumber(plan.ttlMs) or 1000) / 1000, 5))
    DecompilerPlan.expiresAt = os.clock() + ttlSeconds
    return DecompilerPlan.providerId
end

local function ShouldUseDirectBuiltIn(generation, clientId)
    if DecompilerPlan.blockedBuiltinUntil > os.clock() then return false end
    return type(BuiltInDecompile) == "function" and RefreshDecompilerPlan(false, generation, clientId) == "builtin"
end

local function PostBuiltInObservation(body, generation, clientId)
    if not IsActiveMappingContext(generation, clientId) then return end
    local session = ScriptMappingPipeline.session
    if not session then return end
    BuiltInObservations.revision += 1
    body.clientId = clientId
    body.providerId = "builtin"
    body.observationSessionId = session.id
    body.observationSessionStartedAt = session.startedAt
    body.observationRevision = BuiltInObservations.revision
    body.beginObservationSession = true
    task.defer(function()
        if not IsActiveMappingContext(generation, clientId) then return end
        pcall(request, {
            Url = "http://" .. BridgeURL .. "/decompiler-observations",
            Method = "POST",
            Headers = {
                ["Content-Type"] = "application/json",
                ["Accept"] = "application/json",
            },
            Body = HttpService:JSONEncode(body),
        })
    end)
end

local function ReportBuiltInDecompileSuccess(latencyMs, generation, clientId)
    if not IsActiveMappingContext(generation, clientId) then return end
    local now = os.clock()
    if BuiltInObservations.lastAt == nil or now - BuiltInObservations.lastAt > 2 then
        BuiltInObservations.startedAt = now
        BuiltInObservations.samples = 0
    end

    BuiltInObservations.lastAt = now
    BuiltInObservations.startedAt = BuiltInObservations.startedAt or now
    BuiltInObservations.samples += 1
    if now - BuiltInObservations.startedAt < 0.25 then return end
    if now - BuiltInObservations.lastReportAt < 0.5 then return end
    BuiltInObservations.lastReportAt = now

    local windowSeconds = math.max(0.001, now - BuiltInObservations.startedAt)
    PostBuiltInObservation({
        latencyMs = latencyMs,
        successCount = BuiltInObservations.samples,
        throughputPerSecond = BuiltInObservations.samples / windowSeconds,
        throughputWindowMs = windowSeconds * 1000,
        throughputSamples = BuiltInObservations.samples,
    }, generation, clientId)
end

local function ReportBuiltInDecompileFailure(errorMessage, latencyMs, timedOut, generation, clientId)
    if not IsActiveMappingContext(generation, clientId) then return end
    DecompilerPlan.providerId = nil
    DecompilerPlan.expiresAt = 0
    DecompilerPlan.blockedBuiltinUntil = os.clock() + 5
    if timedOut == true then Concurrency:Reduce() end
    PostBuiltInObservation({
        latencyMs = latencyMs,
        errorMessage = tostring(errorMessage or "Built-in decompile failed."),
        timedOut = timedOut == true,
    }, generation, clientId)
end

local function RequestServerDecompile(bytecode, options, generation, clientId)
    if type(request) ~= "function" then
        return nil, "request function is unavailable"
    end

    options = if type(options) == "table" then options else {}
    local body = {
        clientId = clientId,
        bytecode = base64_encode(bytecode),
        builtinAvailable = type(BuiltInDecompile) == "function",
    }
    if type(options.builtinSource) == "string" then
        body.builtinSource = options.builtinSource
    end
    if type(options.builtinLatencyMs) == "number" then
        body.builtinLatencyMs = options.builtinLatencyMs
    end
    if type(options.requestedProvider) == "string" then
        body.requestedProvider = options.requestedProvider
    end
    if type(options.disabledProviders) == "table" then
        body.disabledProviders = options.disabledProviders
    end

    local success, response = RunWithTimeout(ServerDecompileTimeoutSeconds, function()
        return request({
            Url = "http://" .. BridgeURL .. "/decompile",
            Method = "POST",
            Headers = {
                ["Content-Type"] = "application/json",
                ["Accept"] = "application/json",
            },
            Body = HttpService:JSONEncode(body),
        })
    end)
    if not success then
        return nil, tostring(response)
    end

    if type(response) ~= "table" or type(response.Body) ~= "string" then
        return nil, "Decompile server returned no response body."
    end

    local decodedOk, decoded = pcall(function()
        return HttpService:JSONDecode(response.Body)
    end)
    if not decodedOk or type(decoded) ~= "table" then
        return nil, "Decompile server returned invalid JSON."
    end

    if decoded.ok == true and type(decoded.source) == "string" and decoded.source ~= "" then
        return StripDecompilerBanner(decoded.source)
    end
    if decoded.needsBuiltin == true and decoded.providerId == "builtin" then
        return nil, nil, true
    end

    if type(decoded.error) == "string" and decoded.error ~= "" then
        return nil, decoded.error
    end
    if type(decoded.attempts) == "table" then
        return nil, table.concat(decoded.attempts, "\n\n")
    end

    return nil, "Decompile server failed without a detailed error."
end

local function PrepareScriptForMapping(script, fetchCache, generation, clientId)
    generation = generation or ScriptMappingPipeline.generation
    clientId = clientId or ScriptMappingPipeline.clientId
    local debugId = script:GetDebugId()
    local scriptHash = GetScriptHashForInstance(script)
    if fetchCache and scriptHash then
        FetchCachedScriptSources(clientId, { scriptHash })
    end

    local cachedSource = scriptHash and ScriptMappingPipeline.sourceCacheByHash[scriptHash] or nil
    if cachedSource then
        return {
            debugId = debugId,
            scriptHash = scriptHash,
            source = cachedSource,
        }
    end

    if ShouldUseDirectBuiltIn(generation, clientId) then
        return {
            debugId = debugId,
            scriptHash = scriptHash,
            useDirectBuiltin = true,
        }
    end

    local okBytecode, bytecodeOrError = ReadScriptBytecode(script)
    if not okBytecode then
        return nil, bytecodeOrError
    end

    return {
        debugId = debugId,
        scriptHash = scriptHash,
        bytecode = bytecodeOrError,
    }
end

local function DecompileScriptSource(script, prepared, generation, clientId)
    generation = generation or ScriptMappingPipeline.generation
    clientId = clientId or ScriptMappingPipeline.clientId
    local prepareError
    if not prepared then
        prepared, prepareError = PrepareScriptForMapping(script, true, generation, clientId)
    end
    if not prepared then
        return nil, prepareError or "Failed to prepare script for decompile.", nil, nil
    end

    if type(prepared.source) == "string" and prepared.source ~= "" then
        return prepared.source, nil, prepared.scriptHash, prepared
    end
    local serverOptions = if prepared.builtinDisabled == true then { disabledProviders = { "builtin" } } else nil
    if prepared.useDirectBuiltin == true then
        local canAttemptDirectBuiltin = DecompilerAttemptState.CanAttemptBuiltIn(
            prepared,
            DecompilerPlan.blockedBuiltinUntil,
            os.clock()
        )
        if canAttemptDirectBuiltin then
            DecompilerAttemptState.MarkBuiltInAttempted(prepared)
            local builtinSource, builtinLatencyMs, builtinError, builtinTimedOut = TryBuiltInDecompile(script)
            if builtinSource then
                ReportBuiltInDecompileSuccess(builtinLatencyMs, generation, clientId)
                if prepared.scriptHash then
                    RememberScriptSourceForHash(prepared.scriptHash, builtinSource)
                end
                return builtinSource, nil, prepared.scriptHash, prepared
            end

            DecompilerAttemptState.DisableBuiltIn(prepared)
            ReportBuiltInDecompileFailure(builtinError, builtinLatencyMs, builtinTimedOut, generation, clientId)
        end
        serverOptions = { disabledProviders = { "builtin" } }

        local okBytecode, bytecodeOrError = PreparedScript.MaterializeServerFallback(prepared, function()
            return ReadScriptBytecode(script)
        end)
        if not okBytecode then
            return nil, bytecodeOrError, prepared.scriptHash, prepared
        end
    end

    if type(prepared.bytecode) ~= "string" then
        return nil, "Prepared script is missing bytecode.", prepared.scriptHash, prepared
    end

    local source, errorMessage, needsBuiltin = RequestServerDecompile(
        prepared.bytecode,
        serverOptions,
        generation,
        clientId
    )
    if needsBuiltin then
        local canAttemptBuiltin = DecompilerAttemptState.CanAttemptBuiltIn(
            prepared,
            DecompilerPlan.blockedBuiltinUntil,
            os.clock()
        )
        if canAttemptBuiltin then
            DecompilerAttemptState.MarkBuiltInAttempted(prepared)
            local builtinSource, builtinLatencyMs, builtinError, builtinTimedOut = TryBuiltInDecompile(script)
            if builtinSource then
                ReportBuiltInDecompileSuccess(builtinLatencyMs, generation, clientId)
                source, errorMessage = RequestServerDecompile(prepared.bytecode, {
                    requestedProvider = "builtin",
                    builtinSource = builtinSource,
                    builtinLatencyMs = builtinLatencyMs,
                }, generation, clientId)
            else
                DecompilerAttemptState.DisableBuiltIn(prepared)
                ReportBuiltInDecompileFailure(builtinError, builtinLatencyMs, builtinTimedOut, generation, clientId)
                source, errorMessage = RequestServerDecompile(prepared.bytecode, {
                    disabledProviders = { "builtin" },
                }, generation, clientId)
            end
        else
            DecompilerAttemptState.DisableBuiltIn(prepared)
            source, errorMessage = RequestServerDecompile(prepared.bytecode, {
                disabledProviders = { "builtin" },
            }, generation, clientId)
        end
    end
    if not source then
        return nil, errorMessage, prepared.scriptHash, prepared
    end

    if prepared.scriptHash then
        RememberScriptSourceForHash(prepared.scriptHash, source)
    end
    return source, nil, prepared.scriptHash, prepared
end

local function ResetDecompilerClient()
    DecompilerPlan.providerId = nil
    DecompilerPlan.expiresAt = 0
    DecompilerPlan.refreshToken = nil
    DecompilerPlan.blockedBuiltinUntil = 0
    BuiltInObservations.startedAt = nil
    BuiltInObservations.lastAt = nil
    BuiltInObservations.samples = 0
    BuiltInObservations.lastReportAt = 0
    BuiltInObservations.revision = 0
end

return {
    DecompileScriptSource = DecompileScriptSource,
    FetchCachedScriptSources = FetchCachedScriptSources,
    GetScriptHashForInstance = GetScriptHashForInstance,
    PrepareScriptForMapping = PrepareScriptForMapping,
    RefreshDecompilerPlan = RefreshDecompilerPlan,
    ResetDecompilerClient = ResetDecompilerClient,
}
end
