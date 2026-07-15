type ConfirmPrompt = (input: { readonly message: string }) => Promise<unknown>;
type CancelPredicate = (value: unknown) => boolean;

export async function confirmBoolean(
  confirm: ConfirmPrompt,
  isCancel: CancelPredicate,
  message: string
): Promise<boolean> {
  const answer = await confirm({ message });
  return !isCancel(answer) && answer === true;
}
