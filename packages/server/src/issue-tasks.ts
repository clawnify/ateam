import { type AteamDb, repo } from "@ateam/db";
import { SerialQueue } from "@ateam/git-core";
import type { CreateIssueTaskInput } from "@ateam/protocol";
import { repositoryName } from "./github-issues";
import type { Services } from "./services";
import { createTaskInProject } from "./sessions";

const queues = new WeakMap<AteamDb, SerialQueue>();

export async function createIssueTask(
	services: Services,
	notify: (id: string) => void,
	input: CreateIssueTaskInput,
) {
	const project = repo.getProject(services.db, input.projectId);
	if (!project?.githubOwner || !project.githubName)
		throw new Error("This project has no GitHub repository.");
	if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0)
		throw new Error("Invalid GitHub issue number.");
	if (typeof input.name !== "string" || !input.name.trim() || typeof input.description !== "string")
		throw new Error("A task title and description are required.");
	const repository = repositoryName(`${project.githubOwner}/${project.githubName}`);
	const url = `https://github.com/${repository}/issues/${input.issueNumber}`;
	let queue = queues.get(services.db);
	if (!queue) {
		queue = new SerialQueue();
		queues.set(services.db, queue);
	}
	return queue.enqueue(url, async () => {
		const existing = repo.findTaskByIssue(services.db, url);
		if (existing) return { task: existing, created: false };
		const task = await createTaskInProject(services, notify, input, {
			url,
			description: input.description,
		});
		return { task, created: true };
	});
}
