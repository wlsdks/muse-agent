/**
 * `/api/user-model/reconfirm-card*` — the Home "Muse가 확인하고 싶은 것" card:
 * Muse states ONE uncertain inference about the user and the owner
 * confirms/corrects in one tap. This is a push UI over the EXISTING pull
 * mechanism — never a new learning channel:
 *
 *   - Selection: `selectReconfirmableSlots` top-1, the exact function
 *     `muse user model review` lists from (@muse/memory, consumed the same
 *     way as apps/cli/src/commands-user.ts's `runUserModelReview`, line 325).
 *   - Mutation: confirm clears `confidence` + bumps `updatedAt` (re-assert,
 *     stops decaying); reject removes the slot — byte-identical to
 *     `runUserModelReview`'s `--confirm` / `--reject` arms (same file,
 *     lines 314-322 / 309-313), applied through the SAME `UserMemoryStore`
 *     the CLI's `FileUserMemoryStore` implements. apps/api cannot import
 *     apps/cli (separate app, see email-status-routes.ts /
 *     inbound-slash-commands.ts for the same constraint), so the mutation is
 *     mirrored here rather than imported — it must stay identical to the CLI
 *     arm if that ever changes.
 *
 * Per-day gate: at most one ANSWERED (confirm or reject) card per LOCAL
 * calendar day, tracked by a sidecar
 * (`@muse/stores` reconfirm-card-answered-store.ts). Fetching the GET never
 * consumes the day — only a recorded POST does. An unknown slotId 404s
 * WITHOUT writing the sidecar (a failed answer must not consume the day).
 */

import { markReconfirmCardAnswered, reconfirmCardAlreadyAnsweredToday } from "@muse/stores";
import { selectReconfirmableSlots, type UserModel, type UserModelSlot } from "@muse/memory";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import { buildReconfirmCard } from "./user-model-reconfirm-card.js";
import type { ServerOptions } from "./server-options.js";

/**
 * The minimal store contract this route needs — mirrors
 * apps/cli/src/commands-user.ts's private `UserModelReviewStore` /
 * `UserModelSlotWriter` shapes rather than the full `UserMemoryStore`: the
 * shared interface declares `upsertUserModelSlot` optional and has no
 * `removeUserModelSlot` at all (only the concrete `FileUserMemoryStore`
 * implements it), and a test fake shouldn't have to stub every unrelated
 * `UserMemoryStore` method just to exercise this card. Only `userModel` is
 * read from the snapshot, so the return type stays narrow to that field
 * rather than the full `UserMemory` shape.
 */
export interface UserModelReconfirmMemoryStore {
  findByUserId(userId: string): Promise<{ readonly userModel?: UserModel } | undefined> | { readonly userModel?: UserModel } | undefined;
  upsertUserModelSlot?(userId: string, slot: UserModelSlot): Promise<unknown> | unknown;
  removeUserModelSlot?(userId: string, id: string): Promise<unknown> | unknown;
}

export interface UserModelReconfirmRoutesOptions {
  readonly authService: ServerOptions["authService"];
  readonly userMemoryStore?: UserModelReconfirmMemoryStore;
  readonly defaultUserId: string;
  readonly reconfirmCardAnsweredFile: string;
  /** Injectable clock for tests; defaults to the real `Date.now`. */
  readonly now?: () => Date;
}

/** Find a slot by id across all four kinds — mirrors
 *  apps/cli/src/commands-user.ts's private `findSlotById` exactly. */
function findSlotById(model: UserModel, id: string): UserModelSlot | undefined {
  return [...model.preferences, ...model.schedule, ...model.vetoes, ...model.goals].find((slot) => slot.id === id);
}

export function registerUserModelReconfirmRoutes(server: FastifyInstance, options: UserModelReconfirmRoutesOptions): void {
  const now = options.now ?? ((): Date => new Date());

  server.get("/api/user-model/reconfirm-card", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(options.authService))) {
      return reply;
    }
    const at = now();
    const alreadyAnswered = await reconfirmCardAlreadyAnsweredToday(options.reconfirmCardAnsweredFile, at).catch(() => false);
    if (alreadyAnswered) {
      return { card: null };
    }
    const model = await loadUserModel(options);
    const reconfirmable = model ? selectReconfirmableSlots(model, { now: at }) : [];
    const top = reconfirmable[0];
    if (!top) {
      return { card: null };
    }
    return { card: buildReconfirmCard(top) };
  });

  server.post("/api/user-model/reconfirm-card/:slotId", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(options.authService))) {
      return reply;
    }
    const { slotId } = request.params as { readonly slotId: string };
    const body = request.body as { readonly verdict?: unknown } | null;
    const verdict = body?.verdict;
    if (verdict !== "confirm" && verdict !== "reject") {
      return reply.status(400).send({ code: "INVALID_VERDICT", message: "verdict must be 'confirm' or 'reject'" });
    }

    const at = now();
    const model = await loadUserModel(options);
    const slot = model ? findSlotById(model, slotId) : undefined;
    if (!slot) {
      return reply.status(404).send({ code: "SLOT_NOT_FOUND", message: `no slot [${slotId}]` });
    }

    if (verdict === "reject") {
      await options.userMemoryStore?.removeUserModelSlot?.(options.defaultUserId, slotId);
    } else {
      const { confidence: _wasInferred, ...rest } = slot;
      const asserted = { ...rest, updatedAt: at } as UserModelSlot;
      await options.userMemoryStore?.upsertUserModelSlot?.(options.defaultUserId, asserted);
    }
    await markReconfirmCardAnswered(options.reconfirmCardAnsweredFile, at);
    return reply.status(200).send({ recorded: true, verdict });
  });
}

async function loadUserModel(options: UserModelReconfirmRoutesOptions): Promise<UserModel | undefined> {
  if (!options.userMemoryStore) return undefined;
  const snap = await Promise.resolve(options.userMemoryStore.findByUserId(options.defaultUserId)).catch(() => undefined);
  const model = snap?.userModel;
  if (!model) return undefined;
  return reviveSlotDates(model);
}

/** The file store round-trips slot `updatedAt` as an ISO STRING — the
 * selection math needs real Dates, and the in-memory fakes tests use hand
 * it Dates already, so normalize both shapes here (the live 500 this fixes
 * only appeared against the real serialized store). */
function reviveSlotDates(model: UserModel): UserModel {
  const revive = <T extends UserModelSlot>(slots: readonly T[]): readonly T[] =>
    slots.map((slot) => (slot.updatedAt instanceof Date ? slot : { ...slot, updatedAt: new Date(slot.updatedAt as unknown as string) }));
  return {
    ...model,
    goals: revive(model.goals ?? []),
    preferences: revive(model.preferences ?? []),
    schedule: revive(model.schedule ?? []),
    vetoes: revive(model.vetoes ?? [])
  };
}
