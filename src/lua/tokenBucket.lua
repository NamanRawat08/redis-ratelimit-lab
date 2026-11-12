-- Token bucket, run atomically inside Redis.
--
-- Redis runs a Lua script start-to-finish without running any other command
-- in between. So "read tokens -> decide -> write tokens" can't be interleaved
-- with another request doing the same thing. That's what makes it race-free.
--
-- KEYS[1] = bucket key, a hash with fields: tokens, ts (last refill, ms)
-- ARGV[1] = capacity
-- ARGV[2] = refill rate, tokens per second
--
-- Returns { allowed (1/0), remaining tokens (whole), retryAfterMs }

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])

-- Use Redis's clock, not the app server's. With several app servers, their
-- clocks can disagree slightly ("clock skew"); Redis gives everyone one clock.
local t = redis.call('TIME') -- { seconds, microseconds }
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])

if tokens == nil then
  -- First request from this client: start with a full bucket.
  tokens = capacity
  ts = now
end

-- Lazy refill, exactly like the in-memory version.
local elapsed_sec = math.max(0, now - ts) / 1000
tokens = math.min(capacity, tokens + elapsed_sec * refill_per_sec)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

-- tostring keeps the fractional part (e.g. 2.5 tokens) when saving.
redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', now)

-- Auto-delete idle buckets: once it would be full again, the key carries no
-- information, so Redis can drop it and free the memory.
local ms_to_full = math.ceil((capacity - tokens) / refill_per_sec * 1000)
redis.call('PEXPIRE', key, math.max(ms_to_full, 1000))

local retry_after_ms = 0
if allowed == 0 then
  retry_after_ms = math.ceil((1 - tokens) / refill_per_sec * 1000)
end

-- Lua numbers become integers when returned to Redis, so floor explicitly.
return { allowed, math.floor(tokens), retry_after_ms }
