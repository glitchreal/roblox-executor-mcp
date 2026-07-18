local JobStatus = {}
JobStatus.__index = JobStatus

function JobStatus.new(pipeline)
    return setmetatable({ pipeline = pipeline }, JobStatus)
end

function JobStatus:Publish()
    self.pipeline.statusDirty = true
end

function JobStatus:MarkMapped(debugId, shouldPublish)
    local pipeline = self.pipeline
    local job = pipeline.jobs[debugId]
    if job and (job.state == "mapped" or job.state == "failed" or job.state == "removed") then
        return false
    end

    if not job then
        job = pipeline:EnsureJob(debugId)
    end

    pipeline:SetJobState(job, "mapped")
    job.prepared = nil
    job.script = nil
    if shouldPublish ~= false then self:Publish() end
    return true
end

function JobStatus:MarkFailed(debugId, errorMessage, shouldPublish)
    local pipeline = self.pipeline
    local job = pipeline.jobs[debugId]
    if job and (job.state == "mapped" or job.state == "failed" or job.state == "removed") then
        return false
    end

    if not job then
        job = pipeline:EnsureJob(debugId)
    end

    pipeline:SetJobState(job, "failed")
    job.errorMessage = tostring(errorMessage or "unknown error")
    job.prepared = nil
    job.script = nil
    warn("[Roblox Executor MCP] Script mapping skipped " .. tostring(debugId) .. ": " .. tostring(errorMessage or "unknown error"))
    if shouldPublish ~= false then self:Publish() end
    return true
end

return JobStatus
