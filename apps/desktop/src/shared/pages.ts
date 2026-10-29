// Where an agent's page is served (main/pages.ts) and framed (the renderer's
// PageFrame). Imports nothing, so both the node and web tsconfigs resolve it.

export const PAGE_SCHEME = "ateam-page";

/** A task's page, by the page id: a replaced page's address stops serving it. */
export const pageUrl = (taskId: string, pageId: string) =>
	`${PAGE_SCHEME}://page/${encodeURIComponent(taskId)}/${encodeURIComponent(pageId)}`;
