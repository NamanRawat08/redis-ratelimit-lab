-- Sliding window log, run atomically inside Redis.
--
-- The log is a SORTED SET: each member is one request, and its score is the
-- request's timestamp. Sorted sets let us delete "everything older than X"
-- and count what's left in one command each.
--
-- KEYS[1] = window key (sorted set)
-- ARGV[1] = limit (max requests per window)
-- ARGV[2] = window length, ms
-- ARGV[3] = unique id for this request (two requests in the same millisecond
--           must not overwrite each other in the set)
--
-- Returns { allowed (1/0), remaining, retryAfterMs }

local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local request_id = ARGV[3]

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

-- 1. Drop requests that have slid out of the window.
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window_ms)

-- 2. Count what's left, and allow if there's room.
local count = redis.call('ZCARD', key)
local allowed = 0
if count < limit then
  redis.call('ZADD', key, now, request_id)
  count = count + 1
  allowed = 1
end

-- The whole set is irrelevant once the newest entry is a full window old.
redis.call('PEXPIRE', key, window_ms)

-- 3. If rejected, a slot opens when the oldest request leaves the window.
local retry_after_ms = 0
if allowed == 0 then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  retry_after_ms = tonumber(oldest[2]) + window_ms - now
end

return { allowed, limit - count, retry_after_ms }
