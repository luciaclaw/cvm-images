/**
 * GitHub tool implementations — list repos, read/create issues, read PRs, comment, trigger workflows.
 *
 * Uses GitHub REST API v3. OAuth token via OAuth 2.0 flow.
 */

import { registerTool } from '../tool-registry.js';
import { getAccessToken } from '../oauth.js';

const GITHUB_API = 'https://api.github.com';

async function githubFetch(path: string, options: { method?: string; body?: unknown } = {}): Promise<any> {
  const token = await getAccessToken('github');
  if (!token) throw new Error('GitHub not connected. Please connect GitHub in Settings.');

  const response = await fetch(`${GITHUB_API}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  // 204 No Content (e.g., workflow dispatch)
  if (response.status === 204) {
    return { ok: true };
  }

  const data = await response.json() as any;
  if (!response.ok) {
    throw new Error(`GitHub API error (${response.status}): ${data.message || 'Unknown error'}`);
  }

  return data;
}

export function registerGithubTools(): void {
  registerTool({
    name: 'github.list_repos',
    description: 'List repositories for the authenticated GitHub user.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by type: all, owner, public, private, member (default: owner)' },
        sort: { type: 'string', description: 'Sort by: created, updated, pushed, full_name (default: updated)' },
        per_page: { type: 'number', description: 'Results per page (max 100, default: 30)' },
      },
    },
    requiredCredentials: ['github'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { type = 'owner', sort = 'updated', per_page = 30 } = args as {
        type?: string; sort?: string; per_page?: number;
      };

      const params = new URLSearchParams({ type, sort, per_page: String(per_page) });
      const data = await githubFetch(`/user/repos?${params}`);

      return {
        repos: (data as any[]).map((repo: any) => ({
          full_name: repo.full_name,
          description: repo.description,
          private: repo.private,
          language: repo.language,
          stargazers_count: repo.stargazers_count,
          updated_at: repo.updated_at,
          html_url: repo.html_url,
        })),
      };
    },
  });

  registerTool({
    name: 'github.read_issue',
    description: 'Read a specific GitHub issue by number.',
    parameters: {
      type: 'object',
      required: ['owner', 'repo', 'issue_number'],
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'number', description: 'Issue number' },
      },
    },
    requiredCredentials: ['github'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { owner, repo, issue_number } = args as { owner: string; repo: string; issue_number: number };

      const data = await githubFetch(`/repos/${owner}/${repo}/issues/${issue_number}`);

      return {
        number: data.number,
        title: data.title,
        state: data.state,
        body: data.body,
        user: data.user?.login,
        labels: (data.labels || []).map((l: any) => l.name),
        assignees: (data.assignees || []).map((a: any) => a.login),
        created_at: data.created_at,
        updated_at: data.updated_at,
        comments: data.comments,
        html_url: data.html_url,
      };
    },
  });

  registerTool({
    name: 'github.create_issue',
    description: 'Create a new GitHub issue. Requires user confirmation.',
    parameters: {
      type: 'object',
      required: ['owner', 'repo', 'title'],
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body (Markdown)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to add' },
        assignees: { type: 'array', items: { type: 'string' }, description: 'Usernames to assign' },
      },
    },
    requiredCredentials: ['github'],
    riskLevel: 'medium',
    requiresConfirmation: true,
    async execute(args) {
      const { owner, repo, title, body, labels, assignees } = args as {
        owner: string; repo: string; title: string; body?: string; labels?: string[]; assignees?: string[];
      };

      const payload: Record<string, unknown> = { title };
      if (body) payload.body = body;
      if (labels) payload.labels = labels;
      if (assignees) payload.assignees = assignees;

      const data = await githubFetch(`/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        body: payload,
      });

      return {
        number: data.number,
        title: data.title,
        html_url: data.html_url,
        state: data.state,
      };
    },
  });

  registerTool({
    name: 'github.read_pr',
    description: 'Read a specific GitHub pull request by number.',
    parameters: {
      type: 'object',
      required: ['owner', 'repo', 'pull_number'],
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
    },
    requiredCredentials: ['github'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { owner, repo, pull_number } = args as { owner: string; repo: string; pull_number: number };

      const data = await githubFetch(`/repos/${owner}/${repo}/pulls/${pull_number}`);

      return {
        number: data.number,
        title: data.title,
        state: data.state,
        body: data.body,
        user: data.user?.login,
        head: data.head?.ref,
        base: data.base?.ref,
        merged: data.merged,
        mergeable: data.mergeable,
        additions: data.additions,
        deletions: data.deletions,
        changed_files: data.changed_files,
        created_at: data.created_at,
        updated_at: data.updated_at,
        html_url: data.html_url,
      };
    },
  });

  registerTool({
    name: 'github.comment',
    description: 'Add a comment to a GitHub issue or pull request. Requires user confirmation.',
    parameters: {
      type: 'object',
      required: ['owner', 'repo', 'issue_number', 'body'],
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'number', description: 'Issue or PR number' },
        body: { type: 'string', description: 'Comment body (Markdown)' },
      },
    },
    requiredCredentials: ['github'],
    riskLevel: 'medium',
    requiresConfirmation: true,
    async execute(args) {
      const { owner, repo, issue_number, body } = args as {
        owner: string; repo: string; issue_number: number; body: string;
      };

      const data = await githubFetch(`/repos/${owner}/${repo}/issues/${issue_number}/comments`, {
        method: 'POST',
        body: { body },
      });

      return {
        id: data.id,
        html_url: data.html_url,
        created_at: data.created_at,
      };
    },
  });

  registerTool({
    name: 'github.trigger_workflow',
    description: 'Trigger a GitHub Actions workflow dispatch event. Requires user confirmation.',
    parameters: {
      type: 'object',
      required: ['owner', 'repo', 'workflow_id', 'ref'],
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        workflow_id: { type: 'string', description: 'Workflow filename (e.g., "ci.yml") or ID' },
        ref: { type: 'string', description: 'Git ref (branch or tag) to run the workflow on' },
        inputs: { type: 'object', additionalProperties: { type: 'string' }, description: 'Workflow input parameters' },
      },
    },
    requiredCredentials: ['github'],
    riskLevel: 'high',
    requiresConfirmation: true,
    async execute(args) {
      const { owner, repo, workflow_id, ref, inputs } = args as {
        owner: string; repo: string; workflow_id: string; ref: string; inputs?: Record<string, unknown>;
      };

      const payload: Record<string, unknown> = { ref };
      if (inputs) payload.inputs = inputs;

      await githubFetch(`/repos/${owner}/${repo}/actions/workflows/${workflow_id}/dispatches`, {
        method: 'POST',
        body: payload,
      });

      return {
        ok: true,
        message: `Workflow ${workflow_id} triggered on ${owner}/${repo} (ref: ${ref})`,
      };
    },
  });
}
