// Where an agent's page is served (main/pages.ts) and framed (the renderer's
// PageFrame). Imports nothing, so both the node and web tsconfigs resolve it.

export const PAGE_SCHEME = "ateam-page";

/** A saved artifact by id. Explicit revisions keep this address. */
export const pageUrl = (taskId: string, pageId: string) =>
	`${PAGE_SCHEME}://page/${encodeURIComponent(taskId)}/${encodeURIComponent(pageId)}`;
