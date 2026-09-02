import assert from "node:assert/strict";
import test from "node:test";

import {
	classifyShellCommand,
	isReadOnlyShellCommand,
} from "../packages/coding-agent/src/kpi/extensions/shell-classifier.ts";

test("read-only heads and shell control words classify as read-only", () => {
	for (const command of [
		"ls -la /etc",
		"cat a | grep b | wc -l",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion, not a template
		"printf '%s\\n' \"${X:-}\"",
		'for f in a b; do if [ -e "$f" ]; then echo y; fi; done',
		"command -v kpi || true",
		"echo $(git rev-parse HEAD)",
		"echo `pwd`",
		"git --no-pager log -3",
		"git -C packages/ai status --short",
		"npm ls --depth=0",
		"npm audit",
		"node --version",
		"foo --help",
		"foo --version",
		"env FOO=1 ls",
		"xargs -n1 cat",
		"timeout 5 ls",
		"sed -n 1p x",
		"sed -ne '/a/p' x",
		"awk '{ print $1 }' x",
		"X=1; echo $X",
		"set -euo pipefail; ls",
		"ls >/dev/null 2>&1",
		"ls 2>&-",
		"wc -l < file.txt",
		"(cd src && ls)",
		"case $x in a) ls;; *) pwd;; esac",
		'while read -r line; do echo "$line"; done < list.txt',
		"grep -rn foo src | head -n 5",
		"git show HEAD --stat",
		"git branch -a",
		"git remote -v",
		"git config --get user.name",
		"git stash list",
		"echo 'a;b' | wc -c",
		"cat 'file with spaces.txt'",
		"find . -name '*.ts' -not -path './node_modules/*'",
		"rg --files | head",
		"ls # a comment",
		"",
	]) {
		assert.deepEqual(classifyShellCommand(command), { readOnly: true }, command);
	}
});

test("anything that can mutate, execute, or write is not read-only", () => {
	for (const command of [
		"ls > out.txt",
		"echo x >> f",
		"cat <<EOF\nx\nEOF",
		"cat <<< 'x'",
		"find . -delete",
		"find . -exec rm {} ;",
		"fd -x rm",
		"sort -o f f",
		"sed -i s/a/b/ f",
		"sed 's/a/b/' f",
		"sed -n 'w out' f",
		"awk 'BEGIN{system(\"id\")}'",
		"awk '{ print > \"f\" }' x",
		"git branch new",
		"git remote add o u",
		"git config user.name x",
		"git diff --output=f",
		"git stash pop",
		"git checkout -- .",
		"npm audit fix",
		"npm test",
		"npm run build",
		"node script.js --help",
		"node -e 'process.exit()'",
		"curl https://example.test",
		"sudo ls",
		"ls &",
		"cat <(ls)",
		"rm --help -rf /",
		'echo "x',
		"echo 'x",
		"echo $(rm -rf /)",
		"$(echo ls)",
		"`echo ls`",
		"(cd src && rm x)",
		"xargs -n1 rm",
		"env FOO=1 rm x",
		"timeout 5 rm x",
		"npm test 2>&1 | tail",
		"yes | head -1",
		"tee out.txt",
		"function f { ls; }",
		"f() { ls; }",
		"nohup ls",
		"cd a b",
		"set -- a b",
		"date -s '2020-01-01'",
		"rg --pre cat x",
		"ls -la; cat x > y",
	]) {
		assert.equal(isReadOnlyShellCommand(command), false, command);
		const verdict = classifyShellCommand(command);
		assert.ok(!verdict.readOnly && verdict.reason.length > 0, `${command} names a reason`);
	}
});

test("the verdict names the segment that decided it", () => {
	const verdict = classifyShellCommand("git status && curl https://example.test | jq .");
	assert.deepEqual(verdict, {
		readOnly: false,
		reason: 'unknown head "curl"',
		segment: "curl https://example.test",
	});
	const redirect = classifyShellCommand("ls; echo x > out.txt");
	assert.equal(redirect.readOnly, false);
	assert.match(redirect.readOnly ? "" : redirect.reason, /a redirect that writes a file \(>out\.txt\)/u);
	const background = classifyShellCommand("sleep 1 &");
	assert.match(background.readOnly ? "" : background.reason, /background job/u);
});

test("a substitution is classified recursively, secrets included", () => {
	assert.equal(isReadOnlyShellCommand('echo "$(cat .env)"'), true, "secrecy is the policy's rule, not this one");
	assert.equal(isReadOnlyShellCommand('echo "$(cat $(cat list) )"'), true);
	assert.equal(isReadOnlyShellCommand('echo "$(cat $(rm list) )"'), false);
	assert.equal(isReadOnlyShellCommand("echo `ls `pwd``"), true);
	// Built by concatenation so the shell expansion is not read as a template.
	const hidden = ['echo "$', '{X:-$(rm x)}"'].join("");
	assert.equal(isReadOnlyShellCommand(hidden), false, "a substitution hidden in a parameter expansion");
});
