# Call Campaign Simulator — Technical Assessment

## Overview

Build a **call campaign simulator** in Node.js + TypeScript. A campaign connects to a customer list and calls each number sequentially, subject to scheduling constraints, concurrency limits, retry logic, and daily usage caps.

Your solution should be a working simulation — no real calls are made. Calls are simulated with configurable durations and outcomes.

---

## Requirements

### Campaign Configuration

A campaign is initialized with the following parameters:

| Parameter            | Type       | Description                                                       |
| -------------------- | ---------- | ----------------------------------------------------------------- |
| `customerList`       | `string[]` | Array of 100 phone numbers to call                                |
| `startTime`          | `string`   | Daily start time in `HH:mm` format (e.g., `"09:00"`)              |
| `endTime`            | `string`   | Daily end time in `HH:mm` format (e.g., `"17:00"`)                |
| `maxConcurrentCalls` | `number`   | Maximum simultaneous active calls (e.g., `3`)                     |
| `maxDailyMinutes`    | `number`   | Maximum total call minutes per calendar day (e.g., `120`)         |
| `maxRetries`         | `number`   | Maximum retry attempts for a failed call (default: `2`)           |
| `retryDelayMs`       | `number`   | Delay before retrying a failed call (default: `3600000` — 1 hour) |

### Core Behavior

1. **Sequential processing**: The campaign works through the customer list in order. When a call slot opens, the next unprocessed number is dialed (unless a retry is due — see §4).

2. **Working hours**: Calls may only be placed between `startTime` and `endTime` each day. Outside this window, no new calls are initiated. The campaign should resume automatically when the next working window begins.

3. **Pause / Resume**: The campaign can be paused and resumed at any time via `pause()` and `resume()`. While paused, no new calls are initiated.

4. **Retries**: If a call fails, the number is scheduled for a retry after `retryDelayMs`. A number can be retried up to `maxRetries` times. Retries are additional attempts beyond the original call.

5. **Concurrent calls**: Up to `maxConcurrentCalls` may be active simultaneously. When a call completes (success or fail), the slot is freed for the next call.

6. **Daily minute cap**: Track total call duration per calendar day. No new calls may be started if doing so would risk exceeding the daily cap. The cap resets at midnight.

7. **Completion**: The campaign is "complete" when all numbers have been called and either succeeded or exhausted their retry attempts — and no retries remain pending.

### Simulated Clock

Your Campaign receives an `IClock` instance (defined in `interfaces.ts`) via the constructor. You must use this clock for **all** time-related operations — getting the current time and scheduling delayed work. This allows tests to control time without real-time delays.

You do **not** need to implement the simulated clock yourself — tests provide one. However, your code must work exclusively through the `IClock` interface.

### Call Simulation

Each call should be simulated using the provided `CallHandler` type (see `interfaces.ts`). The call handler is injected at construction time so tests can control outcomes and durations.

---

## Required Interface

You are provided with an **`interfaces.ts`** file. **Do not modify it.** Your solution will be tested against these types.

Your concrete `Campaign` class must:

1. Implement the `ICampaign` interface
2. Accept the constructor signature: `new Campaign(config: CampaignConfig, callHandler: CallHandler, clock: IClock)`
3. Be exported from a file called **`solution.ts`**:

```typescript
// solution.ts
export { Campaign } from './your-campaign-file';
```

The `interfaces.ts` file defines: `IClock`, `CallHandler`, `CallResult`, `CampaignConfig`, `CampaignStatus`, `CampaignState`, and `ICampaign`. Read it carefully — it is the contract your code will be evaluated against.

**Important:** Your Campaign must use the injected `IClock` for **all** time operations. Never call `Date.now()`, `setTimeout()`, or `setInterval()` directly.

---

## Deliverables

1. **Source code** — TypeScript, compiles with `tsc`, runs on Node.js 18+.
2. **README** — How to build and run. Document any assumptions you made about unspecified behavior.
3. **A brief design document** — Explain your architecture, how you handle scheduling, and any interesting edge cases you identified.

---

## Evaluation Criteria

| Area               | Weight | What we look for                                                                            |
| ------------------ | ------ | ------------------------------------------------------------------------------------------- |
| Correctness        | 30%    | Does the happy path work? Sequential calling, concurrency, retries.                         |
| Edge case handling | 30%    | How well does it handle ambiguous or conflicting constraints?                               |
| Code quality       | 20%    | Clean separation of concerns, readability, TypeScript usage.                                |
| Design reasoning   | 20%    | Quality of assumptions documented, edge cases identified, architecture decisions explained. |

---

## Time Expectation

Aim for **3–4 hours**. A polished solution with comprehensive edge case coverage may take longer — allocate your time wisely.

---

## Notes

- You may use any npm packages you wish, but the core logic should be your own.
- There is no single "correct" answer to every ambiguous scenario. We care more about your reasoning than your specific choice.
- Do not over-engineer. We value clear, working code over elaborate abstractions.

---

## Plus Task — Timezone Awareness

> **This is optional but highly valued.** Candidates who tackle this demonstrate real-world thinking.

### Background

Currently, `startTime` and `endTime` are plain `HH:mm` strings with no timezone context. In production, campaigns are typically scheduled in the **customer's local timezone** or the **organization's timezone**, not the server's system time. Ignoring timezones leads to calls being made outside working hours for some users — a serious UX (and potentially legal) issue.

### What We'd Like You To Do

Extend `CampaignConfig` with an optional `timezone` field (e.g., `"America/New_York"`, `"Africa/Cairo"`, `"Asia/Tokyo"`):

```typescript
timezone?: string; // IANA timezone string — defaults to UTC if omitted
```

Update your scheduling logic so that:

1. `startTime` and `endTime` are interpreted in the **campaign's configured timezone**, not the server's local time.
2. The daily minute cap resets at **midnight in the campaign's timezone**, not UTC midnight.
3. Your `IClock` abstraction should remain intact — the timezone conversion logic belongs in your campaign scheduling layer, not the clock itself.

### Things to Consider

- What happens when a campaign spans a **DST transition**? (e.g., clocks spring forward — does the working window shrink by an hour that day?)
- What if an invalid or unsupported timezone string is provided?
- How do you test timezone-sensitive logic without flaky real-time behavior? (Hint: your `IClock` abstraction already helps here.)

### Suggested Libraries

- [`luxon`](https://moment.github.io/luxon/) — modern, immutable date/time with full IANA timezone support
- [`date-fns-tz`](https://github.com/marnusw/date-fns-tz) — timezone plugin for `date-fns`

Document your approach and any assumptions in your design document.


### AI Usage
- Used AI in documenting the code well, and in generating test cases.
- Used AI to help me understand the task better.