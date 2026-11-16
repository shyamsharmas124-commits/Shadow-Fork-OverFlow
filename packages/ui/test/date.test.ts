import { describe, expect, it } from "vitest";
import { formatDate } from "../src/utils/date.js";

describe("formatDate unit tests", () => {
  it("formats valid ISO date string correctly", () => {
    const iso = "2026-11-16T12:00:00.000Z";
    const formatted = formatDate(iso);
    expect(formatted).not.toBe("-");
    expect(formatted).not.toBe("Invalid Date");
    expect(typeof formatted).toBe("string");
    expect(formatted.length).toBeGreaterThan(0);
  });

  it("formats Date object correctly", () => {
    const date = new Date("2026-11-16T12:00:00.000Z");
    const formatted = formatDate(date);
    expect(formatted).not.toBe("-");
    expect(formatted).not.toBe("Invalid Date");
  });

  it("formats time-only mode correctly", () => {
    const iso = "2026-11-16T12:00:00.000Z";
    const formattedTime = formatDate(iso, { timeOnly: true });
    expect(formattedTime).not.toBe("-");
    expect(formattedTime).not.toBe("Invalid Date");
  });

  it("returns '-' for null", () => {
    expect(formatDate(null)).toBe("-");
  });

  it("returns '-' for undefined/missing", () => {
    expect(formatDate(undefined)).toBe("-");
    expect(formatDate()).toBe("-");
  });

  it("returns '-' for empty string", () => {
    expect(formatDate("")).toBe("-");
  });

  it("returns '-' for invalid date strings", () => {
    expect(formatDate("not-a-real-date")).toBe("-");
    expect(formatDate("[object Object]")).toBe("-");
  });
});
