# Contributing

Thank you for helping improve Tideline.
This repository is currently a scaffold-only TypeScript monorepo, so contributions should preserve the boundary between documented intent and implemented runtime behavior.

## Development Expectations

Prefer quality, simplicity, robustness, scalability, and long term maintainability over short term development cost.
Keep changes focused on the problem being solved.
Use the existing repository layout and package boundaries before introducing new ones.
Do not add runtime services, schemas, migrations, Docker service definitions, or production source code unless the issue or design plan explicitly calls for implementation work.

Bug fixes should start by reproducing the issue in an end-to-end setting that is as close as possible to the end user's experience.
For UI work, inspect the result carefully and fix obvious visual defects that would affect the user experience.
For engineering work, treat lint failures, test failures, and flaky tests as real problems even when they are adjacent to the immediate task.

## Documentation Standards

Write docs for users, operators, and contributors before explaining internal file wiring.
When writing or substantially editing long Markdown files, put each full sentence on its own physical line.
Avoid claiming behavior exists until the runtime code, tests, and documentation all support that claim.
Do not manually edit `CHANGELOG.md` or any file marked as auto-generated.
Use plain hyphens instead of em dashes.

## Issues

Use issues to describe the problem, expected outcome, constraints, and relevant context.
When reporting bugs, include reproduction steps, observed behavior, expected behavior, environment details, and any logs or screenshots that help explain the issue.
When proposing features, include the user need, tradeoffs, and how the change fits Tideline's context assembly model.

## Pull Requests

Pull requests should follow [.github/pull_request_template.md](.github/pull_request_template.md).
Before requesting review, assign yourself to the PR and add appropriate labels.
Keep PRs small enough to review carefully.
Link related issues, design notes, earlier PRs, or discussion threads when they provide useful context.
Call out dependency, contract, CLI, agent-driver, daemon, state, schema, migration, deployment, or report-format changes explicitly.

## Commit Messages

Use conventional commit subjects with a concise scope.
The preferred shape is:

```text
<type>(<scope>): <short imperative summary>

- <why this change was needed>
- <why this approach or impact matters>
```

Keep the summary short and imperative.
Use types such as `feat`, `fix`, `refactor`, `docs`, `test`, `style`, `perf`, `chore`, `ci`, or `build`.
Do not add agent names, generated authorship lines, or co-author metadata unless the human contributor explicitly requests it.

## Checks

Run the narrowest useful checks while developing, then run the broader checks that match the changed surface area before review.
For scaffold-only documentation changes, `git diff --check` is usually the required baseline.
For TypeScript implementation work, expect to run type checks, tests, linting, and builds once package scripts exist.
Document every command or manual validation step in the PR's Testing section.

## Generated Files

Generated files must be produced by the documented tool that owns them.
Do not hand-edit generated artifacts.
If a generated file changes unexpectedly, explain the generator command and why the output changed.
