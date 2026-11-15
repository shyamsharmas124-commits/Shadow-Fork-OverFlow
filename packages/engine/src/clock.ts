export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class ManualClock implements Clock {
  private current: Date;

  constructor(initial: Date | number = new Date()) {
    this.current = typeof initial === "number" ? new Date(initial) : new Date(initial);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(time: Date | number): void {
    this.current = typeof time === "number" ? new Date(time) : new Date(time);
  }
}
