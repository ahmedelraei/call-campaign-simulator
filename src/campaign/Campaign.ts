import {
  ICampaign,
  IClock,
  CallHandler,
  CampaignConfig,
  CampaignStatus,
  CampaignState,
} from "../types";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

interface RetryEntry {
  phoneNumber: string;
  attempts: number;
  readyAt: number; // absolute timestamp after which we're allowed to retry
}

export class Campaign implements ICampaign {
  private readonly config: CampaignConfig;
  private readonly callHandler: CallHandler;
  private readonly clock: IClock;
  private readonly timezone: string;

  private state: CampaignState = "idle";
  private cursor = 0; // where we are in the customer list -- next index in list
  private activeCallCount = 0;
  private dailyMinutesUsed = 0;
  private currentDay = ""; // tracks the current day (YYYY-MM-DD) so we know when to reset the cap
  private retryQueue: RetryEntry[] = [];
  private totalProcessed = 0;
  private totalFailed = 0;
  private schedulerTimerId: number | null = null;
  private numbersInFlight = new Set<string>();

  constructor(config: CampaignConfig, callHandler: CallHandler, clock: IClock) {
    this.config = {
      ...config,
      maxRetries: config.maxRetries ?? 2,
      retryDelayMs: config.retryDelayMs ?? 3_600_000,
    };
    this.callHandler = callHandler;
    this.clock = clock;
    this.timezone = this.resolveTimezone(config.timezone);
  }

  // --- Public API ---

  start(): void {
    if (this.state === "running" || this.state === "completed") return;
    this.state = "running";
    this.syncDay();
    this.scheduleNext();
  }

  pause(): void {
    if (this.state !== "running") return;
    this.state = "paused";
    this.clearScheduler();
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.state = "running";
    this.syncDay();
    this.scheduleNext();
  }

  getStatus(): CampaignStatus {
    return {
      state: this.state,
      totalProcessed: this.totalProcessed,
      totalFailed: this.totalFailed,
      activeCalls: this.activeCallCount,
      pendingRetries: this.retryQueue.length,
      dailyMinutesUsed: parseFloat(this.dailyMinutesUsed.toFixed(2)),
    };
  }

  // --- Scheduling ---

  // The main heartbeat of the campaign. Every time something changes — a call
  // finishes, we resume, a timer fires — we come back here and try to keep
  // slots filled.
  private scheduleNext(): void {
    if (this.state !== "running") return;

    this.syncDay();

    // No active calls and nothing queued — we might be done
    if (this.activeCallCount === 0) {
      const allDialled = this.cursor >= this.config.customerList.length;
      if (allDialled && this.retryQueue.length === 0) {
        this.state = "completed";
        this.clearScheduler();
        return;
      }
    }

    if (!this.isWithinWorkingHours()) {
      this.scheduleWakeUp();
      return;
    }

    // Keep firing calls until we run out of slots or eligible numbers
    while (this.activeCallCount < this.config.maxConcurrentCalls) {
      if (this.dailyMinutesUsed >= this.config.maxDailyMinutes) {
        this.scheduleMidnightReset();
        return;
      }

      const next = this.pickNextNumber();
      if (next === null) break;

      this.placeCall(next.phoneNumber, next.retryAttempt);
    }
  }

  // Figure out who to call next. Pending retries go first.
  //
  // One edge case worth noting: if the same number appears multiple times in
  // the list and it's currently in a live call, we skip over it temporarily
  // rather than advancing the cursor — so it gets another chance once the
  // first call wraps up.
  private pickNextNumber(): {
    phoneNumber: string;
    retryAttempt: number;
  } | null {
    // Check retries before fresh numbers — don't retry a number already mid-call
    const now = this.clock.now();
    for (let i = 0; i < this.retryQueue.length; i++) {
      const entry = this.retryQueue[i]!;
      if (
        entry.readyAt <= now &&
        !this.numbersInFlight.has(entry.phoneNumber)
      ) {
        this.retryQueue.splice(i, 1);
        return { phoneNumber: entry.phoneNumber, retryAttempt: entry.attempts };
      }
    }

    // Walk forward from the cursor. If the next number is already in a live call,
    // leave the cursor where it is and try the one after it instead.
    for (let i = this.cursor; i < this.config.customerList.length; i++) {
      const phone = this.config.customerList[i]!;
      if (!this.numbersInFlight.has(phone)) {
        this.cursor = i + 1;
        return { phoneNumber: phone, retryAttempt: 0 };
      }
    }

    return null;
  }

  private placeCall(phoneNumber: string, retryAttempt: number): void {
    this.activeCallCount++;
    this.numbersInFlight.add(phoneNumber);

    this.callHandler(phoneNumber)
      .then((result) => {
        this.activeCallCount--;
        this.numbersInFlight.delete(phoneNumber);
        // TODO: I think we should add the duration to the daily minutes only if the call was answered.
        this.dailyMinutesUsed += result.durationMs / 60_000;

        if (result.answered) {
          this.totalProcessed++;
        } else {
          this.handleFailedCall(phoneNumber, retryAttempt);
        }

        this.scheduleNext();
      })
      .catch(() => {
        this.activeCallCount--;
        this.numbersInFlight.delete(phoneNumber);
        this.handleFailedCall(phoneNumber, retryAttempt);
        this.scheduleNext();
      });
  }

  private handleFailedCall(phoneNumber: string, currentAttempt: number): void {
    const nextAttempt = currentAttempt + 1;

    if (nextAttempt > this.config.maxRetries) {
      this.totalFailed++;
      return;
    }

    this.retryQueue.push({
      phoneNumber,
      attempts: nextAttempt,
      readyAt: this.clock.now() + this.config.retryDelayMs,
    });

    // Set a timer to wake us back up when the retry window opens
    this.clock.setTimeout(() => {
      if (this.state === "running") this.scheduleNext();
    }, this.config.retryDelayMs);
  }

  // --- Working hours ---

  private isWithinWorkingHours(): boolean {
    const zonedNow = toZonedTime(new Date(this.clock.now()), this.timezone);
    const currentMinutes = zonedNow.getHours() * 60 + zonedNow.getMinutes();

    const [startH, startM] = this.parseTime(this.config.startTime);
    const [endH, endM] = this.parseTime(this.config.endTime);

    return (
      currentMinutes >= startH * 60 + startM &&
      currentMinutes < endH * 60 + endM
    );
  }

  // Sleep until the working window opens again (today or tomorrow)
  private scheduleWakeUp(): void {
    this.clearScheduler();
    const delayMs = this.msUntilNextStart();
    if (delayMs <= 0) return;

    this.schedulerTimerId = this.clock.setTimeout(() => {
      this.schedulerTimerId = null;
      if (this.state === "running") {
        this.syncDay();
        this.scheduleNext();
      }
    }, delayMs);
  }

  // Hit the daily cap — wait for midnight so the counter resets
  private scheduleMidnightReset(): void {
    this.clearScheduler();
    const delayMs = this.msUntilMidnight();
    if (delayMs <= 0) return;

    this.schedulerTimerId = this.clock.setTimeout(() => {
      this.schedulerTimerId = null;
      if (this.state === "running") {
        this.syncDay();
        this.scheduleNext();
      }
    }, delayMs);
  }

  // --- Day / timezone ---

  private syncDay(): void {
    const today = this.todayString();
    if (this.currentDay !== today) {
      this.currentDay = today;
      this.dailyMinutesUsed = 0;
    }
  }

  private todayString(): string {
    const z = toZonedTime(new Date(this.clock.now()), this.timezone);
    const y = z.getFullYear();
    const m = String(z.getMonth() + 1).padStart(2, "0");
    const d = String(z.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // How many ms until the next startTime? If we haven't hit today's start yet,
  // use that. Otherwise, aim for tomorrow's.
  private msUntilNextStart(): number {
    const zonedNow = toZonedTime(new Date(this.clock.now()), this.timezone);
    const [h, m] = this.parseTime(this.config.startTime);
    const next = new Date(zonedNow);
    next.setHours(h, m, 0, 0);
    if (next.getTime() <= zonedNow.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return this.msUntilZonedTarget(next);
  }

  private msUntilMidnight(): number {
    const zonedNow = toZonedTime(new Date(this.clock.now()), this.timezone);
    const midnight = new Date(zonedNow);
    midnight.setHours(0, 0, 0, 0);
    midnight.setDate(midnight.getDate() + 1);
    return this.msUntilZonedTarget(midnight);
  }

  // --- Utility ---

  private parseTime(hhmm: string): [number, number] {
    const [h, m] = hhmm.split(":");
    return [parseInt(h ?? "0", 10), parseInt(m ?? "0", 10)];
  }

  private clearScheduler(): void {
    if (this.schedulerTimerId !== null) {
      this.clock.clearTimeout(this.schedulerTimerId);
      this.schedulerTimerId = null;
    }
  }

  // toZonedTime gives us a "local-looking" Date, but we need a real UTC delta.
  // fromZonedTime converts it back correctly, DST and all.
  private msUntilZonedTarget(zonedDate: Date): number {
    const utcTarget = fromZonedTime(zonedDate, this.timezone).getTime();
    return Math.max(0, utcTarget - this.clock.now());
  }

  private resolveTimezone(tz?: string): string {
    if (!tz) return "UTC";
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return tz;
    } catch {
      return "UTC";
    }
  }
}
