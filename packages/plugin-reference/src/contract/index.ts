export type NoteId = string;

export type Note = {
	readonly id: NoteId;
	readonly title: string;
	readonly createdAt: string;
};
