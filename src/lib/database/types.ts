export interface BookRow {
	key: string;
	id: number | null;
	title: string;
	authors: string;
}

export interface BookInstanceRow {
	book_key: string;
	vault_path: string;
}

export interface ImportSourceRow {
	source_path: string;
	last_processed_mtime: number;
	last_processed_size: number;
	newest_annotation_ts: string | null;
	last_success_ts: number | null;
	last_error: string | null;
	book_key: string | null;
	md5: string | null;
}
