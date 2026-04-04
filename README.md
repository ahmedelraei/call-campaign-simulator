# Call Campaign Simulator

A TypeScript simulation of an outbound call campaign engine. No real calls are made — call outcomes and durations are injected via a `CallHandler` and time is controlled through an `IClock` abstraction, making the entire system fully testable without any real-time delays.

## Requirements

- Node.js 18+
- pnpm

## Install & Build

```bash
pnpm install
pnpm build
```

Compiled output lands in `dist/`.

## Run the Demo

The demo script creates a 10-number campaign with simulated calls (1–5 s durations, 70% answer rate) and runs it in real time:

```bash
pnpm demo
```

Status is printed every 2 seconds. The working window is set to the current clock hour so the campaign starts immediately.

## Project Structure

```
src/
├── types/
│   └── interfaces.ts       # Contract (IClock, CallHandler, CampaignConfig, ICampaign, …)
├── campaign/
│   ├── Campaign.ts         # Campaign implementation
│   ├── Campaign.test.ts    # Unit tests
│   └── index.ts
├── clock/
│   ├── RealTimeClock.ts    # IClock backed by the real system clock
│   └── index.ts
├── demo.ts                 # Runnable demo / manual testing script
└── solution.ts             # Re-export entry point (as required by assessment)
```

## Using the Campaign

```typescript
import { Campaign } from './src/solution';
import { RealTimeClock } from './src/clock';

const clock = new RealTimeClock();

const campaign = new Campaign(
  {
    customerList: ['+20100000001', '+20100000002', /* … */],
    startTime: '09:00',
    endTime: '17:00',
    maxConcurrentCalls: 3,
    maxDailyMinutes: 120,
    maxRetries: 2,
    retryDelayMs: 3_600_000,
    timezone: 'Africa/Cairo', // optional
  },
  (phoneNumber) => myCallHandler(phoneNumber), // returns Promise<CallResult>
  clock,
);

campaign.start();
campaign.pause();
campaign.resume();
console.log(campaign.getStatus());
```

## Assumptions

See `DESIGN.md` for a full list of documented assumptions and edge case decisions.
