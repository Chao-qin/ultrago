export interface DeliveryClaimStore {
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

/** One atomic compare-and-set claim. The database, not the dispatcher process,
 * decides which tick owns the external side effect. */
export async function claimDelivery(
  store: DeliveryClaimStore,
  id: string,
  now: Date,
  claimToken: string,
  leaseMs: number,
  maxAttempts = 5,
): Promise<boolean> {
  const result = await store.updateMany({
    where: {
      id,
      deadLettered: false,
      attempts: { lt: maxAttempts },
      OR: [
        { status: { in: ["pending", "error"] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { status: "running", OR: [{ claimUntil: null }, { claimUntil: { lt: now } }] },
      ],
    },
  data: { status: "running", claimToken, claimUntil: new Date(now.getTime() + leaseMs), nextAttemptAt: null, lastError: null, attempts: { increment: 1 } },
  });
  return result.count === 1;
}
