export type DialogDisposition = "accept" | "dismiss";

/**
 * Fail-close: a page-initiated confirm/prompt is NOT the user's approved
 * intent — dismiss it. alert has only OK (accept just closes it).
 * beforeunload is accepted so a user-approved navigation isn't wedged.
 * Unknown fails closed.
 */
export function decideDialogDisposition(type: string): DialogDisposition {
  switch (type) {
    case "alert":
    case "beforeunload":
      return "accept";
    case "confirm":
    case "prompt":
      return "dismiss";
    default:
      return "dismiss";
  }
}

export interface DialogRecord {
  readonly type: string;
  readonly message: string;
  readonly response?: string;
}

export interface DialogPlan {
  readonly disposition: DialogDisposition;
  readonly acceptValue?: string;
  readonly record: DialogRecord;
}

export function planDialogResponse(type: string, message: string, defaultValue: string): DialogPlan {
  const disposition = decideDialogDisposition(type);
  // Only an ACCEPTED prompt submits text — the page's OWN pre-fill, never
  // invented; a dismissed dialog submits nothing, so there is no response.
  const acceptValue = disposition === "accept" && type === "prompt" ? defaultValue : undefined;
  return {
    disposition,
    ...(acceptValue !== undefined ? { acceptValue } : {}),
    record: { message, type, ...(acceptValue !== undefined ? { response: acceptValue } : {}) }
  };
}

export interface DialogLike {
  accept(value?: string): Promise<void>;
  dismiss(): Promise<void>;
}

export function settleDialog(dialog: DialogLike, plan: DialogPlan): Promise<void> {
  return plan.disposition === "accept" ? dialog.accept(plan.acceptValue) : dialog.dismiss();
}
