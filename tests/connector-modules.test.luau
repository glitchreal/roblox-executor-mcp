local ScriptMappingState = require("../connector-src/mapping/state")
local UploadSession = require("../connector-src/mapping/upload-session")
local DecompilerAttemptState = require("../connector-src/decompiler/attempt-state")
local PreparedScript = require("../connector-src/decompiler/prepared-script")
local WorkerPool = require("../connector-src/utils/worker")
local Concurrency = require("../connector-src/mapping/concurrency")
local JobStatus = require("../connector-src/mapping/job-status")

local state = ScriptMappingState.new()
state.configuredWorkers = 24
local firstSession = UploadSession.new("first", 100, 1)
local equalTimestampSession = UploadSession.new("same-time", 100, 2)
assert(equalTimestampSession.startedAt > firstSession.startedAt, "session epochs must be strictly monotonic")
state:Reset("client", firstSession)

local firstJob = state:TrackJob("script-a")
assert(firstJob ~= nil and firstJob.state == "queued")
assert(state:TryStartMapping(firstJob))
assert(not state:TryStartMapping(firstJob), "only one worker may claim a queued job")
assert(not state:CanDeferScanJob(firstJob, state.generation), "active mapping work must survive scan recovery")
state:SetJobState(firstJob, "awaiting_upload")
state:SetJobState(firstJob, "mapped")
assert(state.total == 1 and state.processed == 1 and state.skipped == 0)

local invalidTransitionOk = pcall(function()
    state:SetJobState(firstJob, "queued")
end)
assert(not invalidTransitionOk, "mapped jobs must not transition back to queued")

local capturedSession = state.session
local capturedGeneration = state.generation
local secondSession = UploadSession.new("second", 200, 2)
state:Reset("client", secondSession)
assert(not state:IsActiveSession(capturedSession, capturedGeneration, "client"))
assert(state:IsActiveSession(secondSession, state.generation, "client"))
assert(capturedSession:NextRevision() == 1)
capturedSession:MarkStarted()
assert(not secondSession.started, "an old upload response must not start the new session")
local recoveryJob = state:TrackJob("recovery")
assert(not state:IsFinished(), "mapping cannot finish before the initial scan")
assert(state:CanDeferScanJob(recoveryJob, state.generation))
state:SetJobState(recoveryJob, "awaiting_upload")
assert(not state:CanDeferScanJob(recoveryJob, state.generation))
state.initialScanFinished = true
assert(state:IsFinished(state.total), "projected uploaded sources complete the scan")

local ownerState = ScriptMappingState.new()
local ownerSession = UploadSession.new("owners", 300, 1)
ownerState:Reset("client", ownerSession)
local statusOwner = JobStatus.new(ownerState)
local ownerJob = ownerState:TrackJob("owned-job")
ownerState:SetJobState(ownerJob, "mapping")
ownerState:SetJobState(ownerJob, "awaiting_upload")
assert(statusOwner:MarkMapped("owned-job"))
assert(ownerState.processed == 1 and ownerState.statusDirty)

local concurrencyWorkerLimit
ownerState.workers = {
    SetMaxConcurrent = function(_, limit)
        concurrencyWorkerLimit = limit
    end,
}
local concurrency = Concurrency.new(ownerState, 24)
concurrency:Reduce()
assert(ownerState.currentWorkers == 12 and concurrencyWorkerLimit == 12)
ownerState.successesSinceWorkerAdjustment = 99
concurrency:RecordSuccess()
assert(ownerState.currentWorkers == 13 and concurrencyWorkerLimit == 13)

local prepared = { useDirectBuiltin = true }
assert(DecompilerAttemptState.CanAttemptBuiltIn(prepared, 0, 1))
DecompilerAttemptState.MarkBuiltInAttempted(prepared)
assert(not DecompilerAttemptState.CanAttemptBuiltIn(prepared, 0, 1))
DecompilerAttemptState.DisableBuiltIn(prepared)
assert(prepared.builtinDisabled == true and prepared.useDirectBuiltin == false)

local invalidatedDirect = { useDirectBuiltin = true }
assert(not DecompilerAttemptState.CanAttemptBuiltIn(invalidatedDirect, 10, 1))
local bytecodeReads = 0
local fallbackReady = PreparedScript.MaterializeServerFallback(invalidatedDirect, function()
    bytecodeReads += 1
    return true, "server-bytecode"
end)
assert(fallbackReady and bytecodeReads == 1)
assert(invalidatedDirect.bytecode == "server-bytecode")
assert(invalidatedDirect.builtinDisabled == true and invalidatedDirect.useDirectBuiltin == false)
assert(PreparedScript.MaterializeServerFallback(invalidatedDirect, function()
    bytecodeReads += 1
    return false, "must not re-read"
end))
assert(bytecodeReads == 1, "retries must retain materialized bytecode")

local scheduled = {}
local fakeTask = {
    defer = function(callback)
        table.insert(scheduled, callback)
    end,
}
local ran = {}
local pool = WorkerPool.new({
    MaxConcurrent = 1,
    TaskLibrary = fakeTask,
    MainCallback = function(value)
        table.insert(ran, value)
    end,
})
pool:QueueOperation("old")
assert(pool.ActiveWorkers == 1 and #scheduled == 1)
pool:Reset()
pool:QueueOperation("new")
assert(pool.ActiveWorkers == 1 and #scheduled == 1, "reset must retain active capacity")
table.remove(scheduled, 1)()
assert(pool.ActiveWorkers == 1 and #scheduled == 1, "new work starts only after stale work releases capacity")
table.remove(scheduled, 1)()
assert(pool.ActiveWorkers == 0 and ran[1] == "new" and ran[2] == nil)

print("connector module lifecycle tests passed")
