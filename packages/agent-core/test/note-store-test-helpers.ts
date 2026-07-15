import { promises as fs } from "node:fs";

export type NoteRecord = { text: string };

const readNotesFromFile = async (noteFile: string): Promise<NoteRecord[]> => {
  const raw = await fs.readFile(noteFile, "utf8");
  return JSON.parse(raw) as NoteRecord[];
};

const withNotesFallback = async <T extends NoteRecord[] | "absent">(noteFile: string, fallback: T): Promise<T> => {
  try {
    return (await readNotesFromFile(noteFile)) as T;
  } catch {
    return fallback;
  }
};

export const readNotesOrAbsent = (noteFile: string): Promise<NoteRecord[] | "absent"> =>
  withNotesFallback(noteFile, "absent" as const);

export const readNotesOrEmpty = (noteFile: string): Promise<NoteRecord[]> =>
  withNotesFallback(noteFile, [] as NoteRecord[]);
