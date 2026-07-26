'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { describe, test, expect, beforeAll, afterAll } = require('bun:test');

// The tools sandbox everything under VIKTOR_REPO_DIR, so tests point it at a throwaway
// fixture repo instead of the real /repo used in production containers.
const REPO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'viktor-entrypoint-test-'));
process.env.VIKTOR_REPO_DIR = REPO_DIR;

const {
  safePath,
  toolReadFile,
  toolListDirectory,
  toolSearchInFiles,
  toolGetFileTree,
  toolFindFiles,
  toolReadFileLines,
  toolGitLog,
  executeTool,
  parseAgentResult,
  repoPathAndHost,
  postFailureComment,
  apiGet,
  pollAgentTurn,
} = require('./entrypoint.js');

function write(relPath, content) {
  const abs = path.join(REPO_DIR, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  write('apps/back/src/auth.service.ts', "export function login(password: string) {\n  return authenticate(password);\n}\n");
  write('apps/front/src/login.component.ts', "export class LoginComponent {\n  // renders the login form\n}\n");
  write('apps/back/src/unrelated.service.ts', 'export function noop() {}\n');
  write('README.md', '# Fixture repo\n');
  write('src/nested/deep/file.txt', 'deep content\n');
  write('multiline.txt', Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));

  execSync('git init -q', { cwd: REPO_DIR });
  execSync('git config user.email test@example.com', { cwd: REPO_DIR });
  execSync('git config user.name Test', { cwd: REPO_DIR });
  execSync('git add -A', { cwd: REPO_DIR });
  execSync('git commit -q -m "initial commit"', { cwd: REPO_DIR });
});

afterAll(() => {
  fs.rmSync(REPO_DIR, { recursive: true, force: true });
});

describe('safePath', () => {
  test('resolves a relative path inside the repo', () => {
    expect(safePath('README.md')).toBe(path.join(REPO_DIR, 'README.md'));
  });

  test('rejects a path that escapes the repo via ..', () => {
    expect(() => safePath('../outside.txt')).toThrow(/outside the repository/);
  });

  // Leading slashes are stripped before resolving, so an absolute-looking path is treated as
  // relative to the repo root rather than escaping it (e.g. "/etc/passwd" -> "<repo>/etc/passwd").
  test('treats a leading-slash path as relative to the repo root', () => {
    expect(safePath('/etc/passwd')).toBe(path.join(REPO_DIR, 'etc/passwd'));
  });
});

describe('toolReadFile', () => {
  test('reads file content', () => {
    expect(toolReadFile({ path: 'README.md' })).toBe('# Fixture repo\n');
  });

  test('reports a missing file', () => {
    expect(toolReadFile({ path: 'does-not-exist.txt' })).toBe('File not found: does-not-exist.txt');
  });

  test('refuses to read a directory', () => {
    expect(toolReadFile({ path: 'src' })).toContain('is a directory, not a file');
  });
});

describe('toolListDirectory', () => {
  test('lists files and directories, directories suffixed with /', () => {
    const result = toolListDirectory({ path: 'apps' });
    expect(result.split('\n').sort()).toEqual(['back/', 'front/']);
  });

  test('defaults to repo root', () => {
    expect(toolListDirectory({})).toContain('README.md');
  });
});

describe('toolSearchInFiles', () => {
  test('finds a plain (non-regex) literal match', () => {
    const result = toolSearchInFiles({ query: 'LoginComponent', path: 'apps/front' });
    expect(result).toContain('login.component.ts');
  });

  // Regression test: search_in_files with regex=true previously ran the file-listing grep
  // without -E, so alternation patterns like "a|b" were treated as a literal string containing
  // a pipe character and never matched anything.
  test('finds matches for an alternation pattern when regex=true', () => {
    const result = toolSearchInFiles({ query: 'login|password|authenticate', path: 'apps', regex: true });
    expect(result).not.toBe('No matches found.');
    expect(result).toContain('auth.service.ts');
    expect(result).toContain('login.component.ts');
  });

  // A "|" is a real, legitimate character to search for literally (e.g. shell scripts, table
  // formatting, a regex embedded in source code) — the tool must keep honoring regex=false
  // exactly, not silently reinterpret the query as an alternation.
  test('treats a pipe character as literal text when regex=false, and does not match a literal pipe-free file', () => {
    const result = toolSearchInFiles({ query: 'login|password|authenticate', path: 'apps', regex: false });
    expect(result).toContain('No matches found');
  });

  // Regression test: the agent has repeatedly called this tool with an alternation query
  // (e.g. "login|password|email") without setting regex: true, and got a bare "No matches
  // found." that reads as "this term doesn't exist in the codebase" even though it plainly does.
  // Rather than guessing the caller's intent (which would break literal "|" searches), the tool
  // surfaces the likely mistake so the caller can retry deliberately with regex: true.
  test('hints at retrying with regex: true when a literal query containing "|" matches nothing', () => {
    const result = toolSearchInFiles({ query: 'login|password|authenticate', path: 'apps', regex: false });
    expect(result).toContain('regex: true');
  });

  test('returns a plain "No matches found." for a literal query with no regex metacharacters', () => {
    expect(toolSearchInFiles({ query: 'nonexistent_token_xyz', path: '.' })).toBe('No matches found.');
  });

  // Regression guard: the production image (deep/Dockerfile, oven/bun:alpine) never installs
  // GNU coreutils, so `grep` is BusyBox grep. BusyBox grep doesn't support GNU-only long options
  // such as `--include=`/`--exclude=`. Passing one makes grep exit with status 2 and empty
  // stdout, which used to be silently reported as "No matches found." for every single query
  // (e.g. a plain, unambiguous search for "password" in a file that plainly contains it).
  // See: docker run --rm oven/bun:alpine grep --help (lists only -HhnlLcoqvsrRiwFE, -m/-A/-B/-C, -e/-f).
  test('never passes a GNU-only long option (--foo) to grep, since BusyBox grep does not support them', () => {
    const source = fs.readFileSync(path.join(__dirname, 'entrypoint.js'), 'utf8');
    const fnStart = source.indexOf('function toolSearchInFiles');
    const fnEnd = source.indexOf('function toolGetFileTree');
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnSource = source.slice(fnStart, fnEnd);
    // Every flag/option passed to grep in this function is a quoted string, e.g. '-r', '-F',
    // '--include=*'. Flag any long-option literal (quoted string starting with --).
    expect(fnSource).not.toMatch(/'--\w/);
  });

  // Same bug, but reproduced against the exact runtime image instead of the dev machine's GNU
  // grep (which happily accepts --include= and would never catch this). Skipped when Docker
  // isn't available (e.g. some CI runners) rather than failing the whole suite.
  const dockerAvailable = (() => {
    try {
      execSync('docker info', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  test.skipIf(!dockerAvailable)(
    'finds a plain literal match when run inside the actual deep/Dockerfile image (BusyBox grep)',
    () => {
      const output = execSync(
        `docker run --rm -v "${REPO_DIR}:/repo:ro" -v "${path.join(__dirname, 'entrypoint.js')}:/tmp/entrypoint.js:ro" ` +
          `-e VIKTOR_REPO_DIR=/repo oven/bun:alpine bun -e ` +
          `"const { toolSearchInFiles } = require('/tmp/entrypoint.js'); console.log(toolSearchInFiles({ query: 'login', path: 'apps' }));"`,
        { encoding: 'utf8', timeout: 60_000 }
      );
      expect(output).toContain('login.component.ts');
    },
    60_000
  );
});

describe('toolGetFileTree', () => {
  test('renders a tree with nested directories', () => {
    const result = toolGetFileTree({ path: 'src', depth: 5 });
    expect(result).toContain('nested/');
    expect(result).toContain('deep/');
    expect(result).toContain('file.txt');
  });
});

describe('toolFindFiles', () => {
  test('finds files by glob pattern', () => {
    const result = toolFindFiles({ pattern: '*.component.ts' });
    expect(result).toContain('apps/front/src/login.component.ts');
  });

  test('returns "No files found." when pattern matches nothing', () => {
    expect(toolFindFiles({ pattern: '*.nonexistent' })).toBe('No files found.');
  });
});

describe('toolReadFileLines', () => {
  test('reads a specific line range', () => {
    const result = toolReadFileLines({ path: 'multiline.txt', from: 2, to: 4 });
    expect(result).toBe('2: line 2\n3: line 3\n4: line 4');
  });

  test('reports when the requested range is beyond the file', () => {
    const result = toolReadFileLines({ path: 'multiline.txt', from: 999, to: 1000 });
    expect(result).toContain('is beyond end of file');
  });
});

describe('toolGitLog', () => {
  test('returns the commit history', () => {
    const result = toolGitLog({});
    expect(result).toContain('initial commit');
  });

  test('scopes the log to a specific file', () => {
    const result = toolGitLog({ path: 'README.md' });
    expect(result).toContain('initial commit');
  });
});

describe('executeTool', () => {
  test('dispatches to the named tool', () => {
    expect(executeTool('read_file', { path: 'README.md' })).toBe('# Fixture repo\n');
  });

  test('reports an unknown tool name', () => {
    expect(executeTool('does_not_exist', {})).toBe('Unknown tool: does_not_exist');
  });
});

describe('repoPathAndHost', () => {
  test('parses a GitHub HTTPS URL', () => {
    expect(repoPathAndHost('https://github.com/owner/repo.git')).toEqual({ host: 'github.com', path: 'owner/repo' });
  });

  test('parses a GitLab URL with subgroups', () => {
    expect(repoPathAndHost('https://gitlab.example.com/group/subgroup/repo.git')).toEqual({
      host: 'gitlab.example.com',
      path: 'group/subgroup/repo',
    });
  });

  test('returns null for an invalid URL', () => {
    expect(repoPathAndHost('not-a-url')).toBeNull();
  });
});

describe('postFailureComment', () => {
  const originalFetch = global.fetch;

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test('posts to the GitHub issues comments endpoint for a github.com repo', async () => {
    let capturedUrl;
    let capturedOptions;
    global.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return { ok: true, json: async () => ({}) };
    };

    await postFailureComment({
      repoUrl: 'https://github.com/owner/repo.git',
      mergeRequestId: '42',
      vcsToken: 'secret-token',
      reason: 'Something went wrong.',
    });

    expect(capturedUrl).toBe('https://api.github.com/repos/owner/repo/issues/42/comments');
    expect(capturedOptions.headers.Authorization).toBe('Bearer secret-token');
    expect(JSON.parse(capturedOptions.body).body).toContain('Something went wrong.');
  });

  test('posts to the GitLab notes endpoint (URL-encoded project path) for a non-github.com repo', async () => {
    let capturedUrl;
    let capturedOptions;
    global.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return { ok: true, json: async () => ({}) };
    };

    await postFailureComment({
      repoUrl: 'https://gitlab.com/group/subgroup/repo.git',
      mergeRequestId: '7',
      vcsToken: 'secret-token',
      reason: 'Boom.',
    });

    expect(capturedUrl).toBe('https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Frepo/merge_requests/7/notes');
    expect(capturedOptions.headers['PRIVATE-TOKEN']).toBe('secret-token');
  });

  test('does nothing when the repo URL, merge request ID, or token is missing', async () => {
    let called = false;
    global.fetch = async () => {
      called = true;
      return { ok: true, json: async () => ({}) };
    };

    await postFailureComment({ repoUrl: '', mergeRequestId: '42', vcsToken: 'x', reason: 'x' });
    await postFailureComment({ repoUrl: 'https://github.com/owner/repo.git', mergeRequestId: '', vcsToken: 'x', reason: 'x' });
    await postFailureComment({ repoUrl: 'https://github.com/owner/repo.git', mergeRequestId: '42', vcsToken: '', reason: 'x' });

    expect(called).toBe(false);
  });

  test('swallows fetch errors instead of throwing', async () => {
    global.fetch = async () => {
      throw new Error('network down');
    };

    await expect(
      postFailureComment({
        repoUrl: 'https://github.com/owner/repo.git',
        mergeRequestId: '42',
        vcsToken: 'secret-token',
        reason: 'x',
      })
    ).resolves.toBeUndefined();
  });
});

describe('pollAgentTurn', () => {
  const originalFetch = global.fetch;

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test('posts the messages then polls status until DONE, returning the result', async () => {
    const calls = [];
    let statusCallCount = 0;
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      if (options?.method === 'POST') {
        return { ok: true, json: async () => ({ reviewId: 'r1', status: 'PENDING' }) };
      }
      statusCallCount++;
      if (statusCallCount < 2) {
        return { ok: true, json: async () => ({ status: 'PENDING' }) };
      }
      return { ok: true, json: async () => ({ status: 'DONE', result: { text: 'done', toolCalls: [], finishReason: 'stop' } }) };
    };

    const result = await pollAgentTurn('https://api.example.com/complete/r1', [{ role: 'user', content: 'hi' }], {
      pollIntervalMs: 1,
      turnTimeoutMs: 1000,
    });

    expect(result).toEqual({ text: 'done', toolCalls: [], finishReason: 'stop' });
    expect(calls[0].options.method).toBe('POST');
    expect(calls.filter((c) => c.url === 'https://api.example.com/complete/r1/status').length).toBe(2);
  });

  test('throws when the turn status resolves to ERROR', async () => {
    global.fetch = async (url, options) => {
      if (options?.method === 'POST') {
        return { ok: true, json: async () => ({ reviewId: 'r1', status: 'PENDING' }) };
      }
      return { ok: true, json: async () => ({ status: 'ERROR', error: 'Model call failed' }) };
    };

    await expect(
      pollAgentTurn('https://api.example.com/complete/r1', [], { pollIntervalMs: 1, turnTimeoutMs: 1000 })
    ).rejects.toThrow('Model call failed');
  });

  test('throws a timeout error when the turn stays PENDING past the budget', async () => {
    global.fetch = async (url, options) => {
      if (options?.method === 'POST') {
        return { ok: true, json: async () => ({ reviewId: 'r1', status: 'PENDING' }) };
      }
      return { ok: true, json: async () => ({ status: 'PENDING' }) };
    };

    await expect(
      pollAgentTurn('https://api.example.com/complete/r1', [], { pollIntervalMs: 5, turnTimeoutMs: 20 })
    ).rejects.toThrow(/timed out/);
  });

  test('does not interrupt polling on a transient network failure of the status GET', async () => {
    let statusCallCount = 0;
    global.fetch = async (url, options) => {
      if (options?.method === 'POST') {
        return { ok: true, json: async () => ({ reviewId: 'r1', status: 'PENDING' }) };
      }
      statusCallCount++;
      if (statusCallCount === 1) {
        throw new Error('network down');
      }
      return { ok: true, json: async () => ({ status: 'DONE', result: { text: 'ok', toolCalls: [], finishReason: 'stop' } }) };
    };

    const result = await pollAgentTurn('https://api.example.com/complete/r1', [], {
      pollIntervalMs: 1,
      turnTimeoutMs: 1000,
    });

    expect(result).toEqual({ text: 'ok', toolCalls: [], finishReason: 'stop' });
    expect(statusCallCount).toBe(2);
  });
});

describe('apiGet', () => {
  const originalFetch = global.fetch;

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test('returns the parsed JSON body on success', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ hello: 'world' }) });

    await expect(apiGet('https://api.example.com/status')).resolves.toEqual({ hello: 'world' });
  });

  test('throws with the status and body text on failure', async () => {
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });

    await expect(apiGet('https://api.example.com/status')).rejects.toThrow(/HTTP 500/);
  });
});

describe('parseAgentResult', () => {
  test('parses raw JSON', () => {
    expect(parseAgentResult('{"completionScore": 80}')).toEqual({ completionScore: 80 });
  });

  test('strips a ```json fenced code block', () => {
    expect(parseAgentResult('```json\n{"completionScore": 80}\n```')).toEqual({ completionScore: 80 });
  });

  test('throws on invalid JSON', () => {
    expect(() => parseAgentResult('not json')).toThrow(/did not return valid JSON/);
  });
});
