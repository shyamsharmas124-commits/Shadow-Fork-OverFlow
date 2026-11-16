import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockStats {
  riskChecks: Array<{ invoiceNumber: string; amount: number; vendor: string }>;
  charges: Array<{
    id: string;
    amount: number;
    customerId: string;
    idempotencyKey: string;
    description?: string;
  }>;
  refunds: Array<{ id: string; chargeId: string; amount: number; idempotencyKey: string }>;
  notifications: Array<{ customerId: string; message: string; invoiceNumber: string }>;
}

export interface MockServers {
  riskServerUrl: string;
  paymentServerUrl: string;
  notificationServerUrl: string;
  stats: MockStats;
  stop: () => Promise<void>;
}

export async function startMockServers(): Promise<MockServers> {
  const stats: MockStats = {
    riskChecks: [],
    charges: [],
    refunds: [],
    notifications: [],
  };

  const chargeCache = new Map<string, unknown>();
  const refundCache = new Map<string, unknown>();

  // 1. Risk Assessment Server
  const riskServer = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/risk-check") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        stats.riskChecks.push(data);
        const amount = Number(data.amount) || 0;
        const isHighRisk = amount > 1000;
        const isMediumRisk = !isHighRisk && amount > 500;
        const responseData = {
          riskLevel: isHighRisk ? "high" : isMediumRisk ? "medium" : "low",
          score: isHighRisk ? 88 : isMediumRisk ? 42 : 12,
          requiresApproval: isHighRisk,
          assessedAt: new Date().toISOString(),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseData));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
      return;
    }
    res.writeHead(404).end();
  });

  // 2. Payment Gateway Server (Stripe-like)
  const paymentServer = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;

    if (req.method === "POST" && req.url === "/charges") {
      try {
        const data = JSON.parse(body);
        const idempotencyKey =
          (req.headers["idempotency-key"] as string) || data.idempotencyKey || "";

        if (idempotencyKey && chargeCache.has(idempotencyKey)) {
          // Idempotent replay
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(chargeCache.get(idempotencyKey)));
          return;
        }

        const charge = {
          id: `ch_${randomUUID().slice(0, 12)}`,
          amount: Number(data.amount) || 0,
          customerId: data.customerId || "cust_unknown",
          idempotencyKey,
          description: data.description,
          status: "succeeded",
          createdAt: new Date().toISOString(),
        };

        stats.charges.push(charge);
        if (idempotencyKey) {
          chargeCache.set(idempotencyKey, charge);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(charge));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid charge request" }));
      }
      return;
    }

    if (req.method === "POST" && req.url === "/refunds") {
      try {
        const data = JSON.parse(body);
        const idempotencyKey =
          (req.headers["idempotency-key"] as string) || data.idempotencyKey || "";

        if (idempotencyKey && refundCache.has(idempotencyKey)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(refundCache.get(idempotencyKey)));
          return;
        }

        const refund = {
          id: `ref_${randomUUID().slice(0, 12)}`,
          chargeId: data.chargeId,
          amount: Number(data.amount) || 0,
          idempotencyKey,
          status: "succeeded",
          createdAt: new Date().toISOString(),
        };

        stats.refunds.push(refund);
        if (idempotencyKey) {
          refundCache.set(idempotencyKey, refund);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(refund));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid refund request" }));
      }
      return;
    }

    res.writeHead(404).end();
  });

  // 3. Customer Notification Webhook Server
  const notificationServer = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/notifications") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        stats.notifications.push(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ delivered: true, deliveredAt: new Date().toISOString() }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
      return;
    }
    res.writeHead(404).end();
  });

  // Start all on random available ports on 127.0.0.1
  await Promise.all([
    new Promise<void>((resolve) => riskServer.listen(0, "127.0.0.1", () => resolve())),
    new Promise<void>((resolve) => paymentServer.listen(0, "127.0.0.1", () => resolve())),
    new Promise<void>((resolve) => notificationServer.listen(0, "127.0.0.1", () => resolve())),
  ]);

  const riskPort = (riskServer.address() as AddressInfo).port;
  const paymentPort = (paymentServer.address() as AddressInfo).port;
  const notificationPort = (notificationServer.address() as AddressInfo).port;

  const stop = async () => {
    await Promise.all([
      new Promise<void>((resolve) => riskServer.close(() => resolve())),
      new Promise<void>((resolve) => paymentServer.close(() => resolve())),
      new Promise<void>((resolve) => notificationServer.close(() => resolve())),
    ]);
  };

  return {
    riskServerUrl: `http://127.0.0.1:${riskPort}`,
    paymentServerUrl: `http://127.0.0.1:${paymentPort}`,
    notificationServerUrl: `http://127.0.0.1:${notificationPort}`,
    stats,
    stop,
  };
}
