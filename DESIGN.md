# Design Document — Call Campaign Simulator

## Architecture

The entire domain logic lives in a single `Campaign` class (`src/campaign/Campaign.ts`). No elaborate abstractions — the spec says "do not over-engineer," and a flat, well-commented class is easier to follow than a graph of collaborator objects.

```
Campaign
 ├── cursor            — index into customerList (next undialled number)
 ├── activeCallCount   — how many calls are in flight right now
 ├── retryQueue        — RetryEntry[] for numbers awaiting a retry
 ├── dailyMinutesUsed  — accumulated call time in the current calendar day
 ├── currentDay        — YYYY-MM-DD string (campaign timezone) used to detect day rollovers
 └── schedulerTimerId  — single timer for working-hour / midnight wake-ups
```

Time is never touched directly. Every `Date.now()`, `setTimeout`, and `clearTimeout` call is routed through the injected `IClock`. This means a simulated clock can fast-forward hours or days in microseconds, which is exactly what tests need.

---

## Scheduling Loop

`scheduleNext()` is the central method. It fires:
- when `start()` or `resume()` is called
- after every call resolves (success or failure)
- when a retry timer fires
- when a working-hour or midnight wake-up timer fires

Each invocation:

1. **Checks completion first** — if nothing is active, nothing is queued, and the list is exhausted, the campaign transitions to `"completed"` without scheduling further work, even if we're outside working hours.
2. **Checks working hours** — if the current time (in the campaign timezone) is before `startTime` or at/after `endTime`, schedules a single wake-up timer for the next window start and returns.
3. **Fills concurrency slots** — loops while `activeCallCount < maxConcurrentCalls`, picks the next number (ready retry first, then fresh from the list), and fires `placeCall`.
4. **Checks the daily cap** — if accumulated minutes `>= maxDailyMinutes`, schedules a wake-up at midnight (campaign timezone) for the cap reset and returns.

Only one scheduler timer is live at a time — `clearScheduler()` cancels the previous one before scheduling a new one.

---

## Retry Strategy

```
attempt 0  — original call
attempt 1  — first retry  (if attempt 0 failed)
attempt 2  — second retry (if attempt 1 failed, and maxRetries = 2)
```

"Up to `maxRetries` additional attempts" means the total dial count is `1 + maxRetries`. The retry entry is created with `attempts = nextAttempt` and is eligible when `readyAt <= clock.now()`.

Each retry entry registers its own `IClock.setTimeout` so the retry fires automatically even if no other calls are finishing around that time. When the timer fires, it calls `scheduleNext()` which then decides if it can pick the retry up (working hours, cap, concurrency all still apply).

Retries take priority over fresh numbers — they're checked first in `pickNextNumber()`. This matches the expectation that a number that failed once should be retried before brand-new numbers are dialled.

---

## Daily Minute Cap

The cap tracks **used** minutes, not planned minutes. A call's duration is only added to `dailyMinutesUsed` after the call resolves, not before. This means:

- We can't predict that a call will push us over the cap, so we gate on accumulated usage.
- A single very long call could push usage modestly over the cap for that day (by at most whatever the longest simulated call is). This is a deliberate conservative trade-off: blocking calls preemptively based on estimated duration would require knowing durations in advance, which we don't.

The daily cap resets when `syncDay()` detects a calendar day change in the campaign timezone. `syncDay()` is called at the top of every `scheduleNext()` invocation.

---

## Pause / Resume

`pause()` sets `state = "paused"` and cancels the scheduler timer. Active calls may still be in flight — their promise handlers still call `scheduleNext()` on completion, but `scheduleNext()` returns immediately when `state !== "running"`, so no new calls are launched.

`resume()` re-enters the scheduling loop. `syncDay()` is called first to handle the case where a pause spans midnight.

---

## Timezone (Plus Task)

`CampaignConfig.timezone` accepts any IANA timezone string (e.g. `"America/New_York"`, `"Africa/Cairo"`). If omitted or invalid, the implementation defaults to UTC silently.

`date-fns-tz`'s `toZonedTime` converts the raw UTC timestamp from `IClock.now()` into a `Date` object whose local `.getHours()` / `.getMinutes()` reflect the campaign timezone. This is used for:

- `isWithinWorkingHours()` — compare current H:mm against `startTime`/`endTime`
- `getCurrentDayString()` — YYYY-MM-DD in campaign tz for day-rollover detection
- `msUntilNextStart()` / `msUntilMidnight()` — computing delays based on campaign-local time

The clock itself stays UTC-agnostic. Timezone conversion is the campaign's concern, not the clock's.

### DST Transitions

On a "spring forward" day (e.g. clock jumps from 02:00 to 03:00), if `startTime = "09:00"` and `endTime = "17:00"`, the working window doesn't change in clock time — it still runs 09:00–17:00 in local time. The working day is one hour shorter in wall-clock minutes, but `date-fns-tz` handles the UTC offset change transparently. No special-casing needed.

On a "fall back" day, the offset change means an hour is lived twice in UTC. Again, because we convert from UTC → local, the first pass through (say) 01:30 local and the second pass both correctly read as within the working window if configured that way — no double-counting.

### Invalid Timezone

The `resolveTimezone()` helper constructs an `Intl.DateTimeFormat` with the provided timezone string. If the runtime rejects it (throws a `RangeError`), the method catches it and silently falls back to `"UTC"`. Production-grade code would probably log a warning; keeping it silent here avoids coupling the class to any particular logger.

---

## Edge Cases & Assumptions

| Scenario | Decision |
|---|---|
| `endTime <= startTime` (e.g. `"17:00"` / `"09:00"`, overnight window) | Not supported. Assumed that `startTime < endTime` within the same calendar day. Documented in README. |
| `customerList` is empty | `start()` immediately transitions to `"completed"` on the first `scheduleNext()` call. |
| `maxDailyMinutes = 0` | Every call attempt is blocked immediately. The campaign will wake at each midnight and immediately block again. The campaign can never complete — treated as a misconfiguration the caller should avoid. |
| `maxConcurrentCalls = 0` | Same as above — the slot-filling loop never runs. |
| Calling `start()` on a completed campaign | No-op. State is checked at the top of `start()`. |
| Calling `pause()` on a paused or idle campaign | No-op. Only transitions from `running`. |
| Calling `resume()` when not paused | No-op. Only transitions from `paused`. |
| A number appears multiple times in `customerList` | `pickNextNumber` scans forward from the cursor but does **not** permanently advance past entries that are in flight — it skips them for the current scheduling pass only. Once the in-flight call resolves and the number leaves `numbersInFlight`, the next `scheduleNext()` invocation will pick up the deferred entry. Callers are still encouraged to deduplicate to avoid unnecessary retries. |
| `callHandler` rejects (throws) | Treated as a failed call. The rejection is caught in `placeCall` and routed through `handleFailedCall`. |
| Retry fires while campaign is paused | The timer callback checks `state === "running"` before calling `scheduleNext()`, so the retry is silently skipped. It remains in `retryQueue` but has no timer anymore. On `resume()`, `scheduleNext()` picks it up if its `readyAt` has passed. |
