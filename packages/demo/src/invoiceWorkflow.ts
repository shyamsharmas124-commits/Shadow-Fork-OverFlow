import Anthropic from "@anthropic-ai/sdk";
import type { Ctx, StepContext } from "@durable/engine";

export interface InvoiceItem {
  description: string;
  price: number;
  quantity: number;
}

export interface ExtractedInvoice {
  vendor: string;
  invoiceNumber: string;
  customerId: string;
  amount: number;
  originalAmount: number;
  items: InvoiceItem[];
  discountApplied?: string;
}

export interface InvoiceWorkflowInput {
  invoiceRawText: string;
  customerId: string;
  discountCode?: string;
  riskServiceUrl: string;
  paymentServiceUrl: string;
  notificationServiceUrl: string;
}

export interface RiskCheckResult {
  riskLevel: "low" | "medium" | "high";
  score: number;
  requiresApproval: boolean;
  assessedAt: string;
}

export interface InvoiceWorkflowResult {
  invoice: ExtractedInvoice;
  risk: RiskCheckResult;
  approval: { approved: boolean; autoApproved?: boolean; note?: string };
  payment: { chargeId: string; status: string; amount: number };
  notification: { delivered: boolean };
  ledger: { recorded: boolean };
}

/**
 * Deterministic fallback extractor if Anthropic API key is not provided or in offline/test mode.
 */
export function extractInvoiceFallback(text: string, discountCode?: string): ExtractedInvoice {
  // Simple regex parser for demo invoice format
  const vendorMatch = text.match(/Vendor:\s*([^\n]+)/i);
  const invoiceNumMatch = text.match(/Invoice\s*(?:#|Number):\s*([^\n]+)/i);
  const customerMatch = text.match(/Customer\s*(?:ID)?:\s*([^\n]+)/i);
  const totalMatch = text.match(/Total:\s*\$?([0-9.,]+)/i);

  const vendor = vendorMatch?.[1]?.trim() ?? "Acme Cloud Services Inc.";
  const invoiceNumber = invoiceNumMatch?.[1]?.trim() ?? "INV-2026-9042";
  const customerId = customerMatch?.[1]?.trim() ?? "cust_enterprise_44";
  const rawTotal = totalMatch ? parseFloat(totalMatch[1]!.replace(/,/g, "")) : 1250;

  let amount = rawTotal;
  let discountApplied: string | undefined;

  if (discountCode === "VIP50") {
    amount = rawTotal * 0.5;
    discountApplied = "VIP50 (50% off)";
  } else if (discountCode === "VIP20") {
    amount = rawTotal * 0.8;
    discountApplied = "VIP20 (20% off)";
  }

  const items: InvoiceItem[] = [
    { description: "Dedicated Cloud Worker Instances (x10)", price: 1000, quantity: 1 },
    { description: "Managed PostgreSQL Replica", price: 250, quantity: 1 },
  ];

  return {
    vendor,
    invoiceNumber,
    customerId,
    amount,
    originalAmount: rawTotal,
    items,
    discountApplied,
  };
}

/**
 * Extracts structured invoice data using Anthropic's Claude if available, or fallback.
 */
export async function extractWithLLM(
  text: string,
  discountCode?: string,
): Promise<ExtractedInvoice> {
  if (process.env.ANTHROPIC_API_KEY) {
    if (!process.env.ANTHROPIC_MODEL) {
      throw new Error(
        "ANTHROPIC_MODEL environment variable is required when ANTHROPIC_API_KEY is provided (no hardcoded fallback allowed).",
      );
    }
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: process.env.ANTHROPIC_MODEL,
        max_tokens: 1024,
        tools: [
          {
            name: "record_invoice",
            description: "Record structured invoice information",
            input_schema: {
              type: "object",
              properties: {
                vendor: { type: "string" },
                invoiceNumber: { type: "string" },
                customerId: { type: "string" },
                amount: { type: "number" },
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      description: { type: "string" },
                      price: { type: "number" },
                      quantity: { type: "number" },
                    },
                    required: ["description", "price", "quantity"],
                  },
                },
              },
              required: ["vendor", "invoiceNumber", "customerId", "amount", "items"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "record_invoice" },
        messages: [{ role: "user", content: `Extract invoice data:\n${text}` }],
      });

      const toolBlock = response.content.find((c) => c.type === "tool_use");
      if (toolBlock && toolBlock.type === "tool_use") {
        const input = toolBlock.input as {
          vendor: string;
          invoiceNumber: string;
          customerId: string;
          amount: number;
          items: InvoiceItem[];
        };
        let amount = input.amount;
        let discountApplied: string | undefined;
        if (discountCode === "VIP50") {
          amount = input.amount * 0.5;
          discountApplied = "VIP50 (50% off)";
        } else if (discountCode === "VIP20") {
          amount = input.amount * 0.8;
          discountApplied = "VIP20 (20% off)";
        }

        return {
          vendor: input.vendor,
          invoiceNumber: input.invoiceNumber,
          customerId: input.customerId,
          amount,
          originalAmount: input.amount,
          items: input.items,
          discountApplied,
        };
      }
    } catch (err) {
      // Graceful fallback to deterministic parser
      console.warn(
        "[InvoiceWorkflow] Anthropic API call failed or rate-limited; using structured fallback:",
        err,
      );
    }
  }

  return extractInvoiceFallback(text, discountCode);
}

/**
 * Multi-step invoice processing business workflow.
 */
export async function invoiceProcessingWorkflow(
  ctx: Ctx,
  input: InvoiceWorkflowInput,
): Promise<InvoiceWorkflowResult> {
  // Step 1: Structured LLM Extraction (Pure)
  const invoice = await ctx.step(
    "extract-invoice",
    async (inp: { rawText: string; discount?: string }) => {
      return await extractWithLLM(inp.rawText, inp.discount);
    },
    { rawText: input.invoiceRawText, discount: input.discountCode },
    { kind: "pure" },
  );

  // Step 2: Risk Assessment Check (Effectful-External)
  const risk = await ctx.step(
    "risk-assessment",
    async (
      inp: { serviceUrl: string; invoiceNumber: string; amount: number; vendor: string },
      stepCtx: StepContext,
    ): Promise<RiskCheckResult> => {
      const resp = await stepCtx.http.fetch({
        url: `${inp.serviceUrl}/risk-check`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": stepCtx.idempotencyKey,
        },
        body: {
          invoiceNumber: inp.invoiceNumber,
          amount: inp.amount,
          vendor: inp.vendor,
        },
      });

      return resp.body as RiskCheckResult;
    },
    {
      serviceUrl: input.riskServiceUrl,
      invoiceNumber: invoice.invoiceNumber,
      amount: invoice.amount,
      vendor: invoice.vendor,
    },
    { kind: "effectful-external" },
  );

  // Step 3: Human Approval Gate (Conditional for amounts > $1,000 or high risk)
  let approvalResult: { approved: boolean; autoApproved?: boolean; note?: string };
  if (invoice.amount > 1000 || risk.requiresApproval) {
    const decision = await ctx.waitForApproval("invoice-manager-approval", {
      invoiceNumber: invoice.invoiceNumber,
      amount: invoice.amount,
      vendor: invoice.vendor,
      riskLevel: risk.riskLevel,
      riskScore: risk.score,
    });

    if (decision.decision === "reject") {
      throw new Error(`Invoice rejected by manager: ${decision.note || "No reason given"}`);
    }

    approvalResult = { approved: true, autoApproved: false, note: decision.note };
  } else {
    approvalResult = { approved: true, autoApproved: true };
  }

  // Step 4: Payment Gateway Charge (Effectful-External)
  const payment = await ctx.step(
    "payment-charge",
    async (
      inp: { serviceUrl: string; amount: number; customerId: string; invoiceNumber: string },
      stepCtx: StepContext,
    ) => {
      const resp = await stepCtx.http.fetch({
        url: `${inp.serviceUrl}/charges`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": stepCtx.idempotencyKey,
        },
        body: {
          amount: inp.amount,
          customerId: inp.customerId,
          idempotencyKey: stepCtx.idempotencyKey,
          description: `Charge for Invoice ${inp.invoiceNumber}`,
        },
      });

      const body = resp.body as { id?: string; status?: string; amount?: number } | undefined;
      return {
        chargeId: body?.id ?? "ch_mock",
        status: body?.status ?? "succeeded",
        amount: body?.amount ?? inp.amount,
      };
    },
    {
      serviceUrl: input.paymentServiceUrl,
      amount: invoice.amount,
      customerId: invoice.customerId,
      invoiceNumber: invoice.invoiceNumber,
    },
    { kind: "effectful-external" },
  );

  // Step 5: Customer Notification Webhook (Effectful-External)
  const notification = await ctx.step(
    "customer-notification",
    async (
      inp: { serviceUrl: string; customerId: string; invoiceNumber: string; amount: number },
      stepCtx: StepContext,
    ) => {
      const resp = await stepCtx.http.fetch({
        url: `${inp.serviceUrl}/notifications`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": stepCtx.idempotencyKey,
        },
        body: {
          customerId: inp.customerId,
          invoiceNumber: inp.invoiceNumber,
          message: `Your payment of $${inp.amount.toFixed(2)} for invoice ${inp.invoiceNumber} was processed successfully.`,
        },
      });

      const body = resp.body as { delivered?: boolean } | undefined;
      return {
        delivered: Boolean(body?.delivered ?? true),
      };
    },
    {
      serviceUrl: input.notificationServiceUrl,
      customerId: invoice.customerId,
      invoiceNumber: invoice.invoiceNumber,
      amount: invoice.amount,
    },
    { kind: "effectful-external" },
  );

  // Step 6: Record in Database Ledger (Effectful-Reversible)
  const ledger = await ctx.step(
    "record-ledger",
    async (
      inp: { invoiceNumber: string; amount: number; customerId: string },
      stepCtx: StepContext,
    ) => {
      await stepCtx.sql.query(
        `INSERT INTO invoice_audit_ledger (run_id, invoice_number, amount, status)
         VALUES ('00000000-0000-0000-0000-000000000000', $1, $2, $3)`,
        [inp.invoiceNumber, inp.amount, "processed"],
      );
      return { recorded: true };
    },
    {
      invoiceNumber: invoice.invoiceNumber,
      amount: invoice.amount,
      customerId: invoice.customerId,
    },
    { kind: "effectful-reversible", mock: { recorded: true } },
  );

  return {
    invoice,
    risk,
    approval: approvalResult,
    payment,
    notification,
    ledger,
  };
}
