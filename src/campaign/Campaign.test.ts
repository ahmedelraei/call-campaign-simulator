import test from 'node:test';
import assert from 'node:assert/strict';

import { CallHandler, CampaignConfig, IClock } from '../types';
import { Campaign } from './Campaign';

class FixedClock implements IClock {
  private nextId = 1;
  private readonly timers = new Map<number, { delayMs: number; callback: () => void }>();

  constructor(private currentTime: number) {}

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { delayMs, callback });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }
}

type CampaignInternals = {
  handleFailedCall: (phoneNumber: string, currentAttempt: number) => void;
  msUntilNextStart: () => number;
  msUntilMidnight: () => number;
};

const callHandler: CallHandler = async () => ({ answered: true, durationMs: 0 });

function createConfig(overrides: Partial<CampaignConfig> = {}): CampaignConfig {
  return {
    customerList: ['+15550000001'],
    startTime: '09:00',
    endTime: '17:00',
    maxConcurrentCalls: 1,
    maxDailyMinutes: 60,
    maxRetries: 2,
    retryDelayMs: 1_000,
    timezone: 'UTC',
    ...overrides,
  };
}

test('allows the final configured retry attempt before failing permanently', () => {
  const campaign = new Campaign(createConfig({ maxRetries: 2 }), callHandler, new FixedClock(0));
  const internals = campaign as unknown as CampaignInternals;

  internals.handleFailedCall('+15550000001', 1);

  const status = campaign.getStatus();
  assert.equal(status.pendingRetries, 1);
  assert.equal(status.totalFailed, 0);
});

test('marks a number failed only after exceeding the configured retries', () => {
  const campaign = new Campaign(createConfig({ maxRetries: 2 }), callHandler, new FixedClock(0));
  const internals = campaign as unknown as CampaignInternals;

  internals.handleFailedCall('+15550000001', 2);

  const status = campaign.getStatus();
  assert.equal(status.pendingRetries, 0);
  assert.equal(status.totalFailed, 1);
});

test('computes next start delay using real elapsed time across spring-forward', () => {
  const now = Date.parse('2026-03-08T04:00:00.000Z');
  const campaign = new Campaign(
    createConfig({ timezone: 'America/New_York', startTime: '09:00' }),
    callHandler,
    new FixedClock(now)
  );
  const internals = campaign as unknown as CampaignInternals;

  assert.equal(internals.msUntilNextStart(), 9 * 60 * 60 * 1000);
});

test('computes midnight reset delay using timezone offsets on DST transition days', () => {
  const now = Date.parse('2026-03-08T05:30:00.000Z');
  const campaign = new Campaign(
    createConfig({ timezone: 'America/New_York' }),
    callHandler,
    new FixedClock(now)
  );
  const internals = campaign as unknown as CampaignInternals;

  assert.equal(internals.msUntilMidnight(), 22.5 * 60 * 60 * 1000);
});
