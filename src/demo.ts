import { Campaign } from './campaign';
import { RealTimeClock } from './clock';
import { CallResult } from './types';

/**
 * Quick demo that spins up a campaign with 10 numbers and runs it in real time.
 * Calls are simulated with random durations (1–5 seconds) and a 70% answer rate.
 *
 * Usage:
 *   pnpm build && node dist/demo.js
 */

const phoneNumbers = Array.from({ length: 10 }, (_, i) =>
  `+2010000000${String(i).padStart(2, '0')}`
);

const clock = new RealTimeClock();

// simulated call handler — resolves after a random delay
function simulateCall(phoneNumber: string): Promise<CallResult> {
  const durationMs = 1000 + Math.floor(Math.random() * 4000); // 1–5 s
  const answered = Math.random() < 0.7;

  return new Promise((resolve) => {
    clock.setTimeout(() => {
      const tag = answered ? '✓ answered' : '✗ no answer';
      console.log(`  [${tag}] ${phoneNumber} (${(durationMs / 1000).toFixed(1)}s)`);
      resolve({ answered, durationMs });
    }, durationMs);
  });
}

const now = new Date();
const hours = now.getHours();

// detect the local IANA timezone so startTime/endTime are interpreted correctly
const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// set working window to current hour + 2 so the demo runs immediately
const startTime = `${String(hours).padStart(2, '0')}:00`;
const endTime = `${String(hours + 2).padStart(2, '0')}:00`;

const campaign = new Campaign(
  {
    customerList: phoneNumbers,
    startTime,
    endTime,
    maxConcurrentCalls: 3,
    maxDailyMinutes: 60,
    maxRetries: 2,
    retryDelayMs: 5000, // 5 seconds for demo purposes
    timezone: localTimezone,
  },
  simulateCall,
  clock,
);

console.log(`\n📞 Call Campaign Demo`);
console.log(`   ${phoneNumbers.length} numbers | window ${startTime}–${endTime} | max 3 concurrent\n`);

campaign.start();

// poll status every 2 seconds
const statusInterval = setInterval(() => {
  const s = campaign.getStatus();
  console.log(
    `   [${s.state}] processed=${s.totalProcessed} failed=${s.totalFailed} ` +
    `active=${s.activeCalls} retries=${s.pendingRetries} daily=${s.dailyMinutesUsed.toFixed(1)}m`
  );

  if (s.state === 'completed') {
    console.log('\n✅ Campaign complete.\n');
    clearInterval(statusInterval);
  }
}, 2000);
