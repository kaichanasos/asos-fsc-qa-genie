# QA Genie

Write a test as a Markdown file. An LLM on Azure AI Foundry reads it, drives a real (visible) browser through Playwright, and returns a pass/fail verdict with a screenshot of every step as evidence.

## Setup

```sh
npm install
npm run setup          # downloads Chromium (skip if you use BROWSER_CHANNEL=msedge)
cp .env.example .env   # fill in FOUNDRY_ENDPOINT and FOUNDRY_MODEL
az login               # unless you set FOUNDRY_API_KEY
```

Requires Node 22.18+ (TypeScript runs directly, no build step).

## Run a test

```sh
npm start -- tasks/login.md
npm start -- tasks/login.md --headless
```

Exit code: `0` passed, `1` failed, `2` did not finish (error, step limit, timeout, Ctrl+C).

Each run writes `runs/<timestamp>_<task>/`:

| File | Contents |
|---|---|
| `report.md` | Verdict, summary, and every step with its locator and screenshot |
| `screenshots/step-NNN-*.png` | One screenshot after every action |
| `transcript.jsonl` | Every model reply and tool call |
| `result.json` | Machine-readable result |
| `trace.zip` | Only with `TRACE=true`, and only for runs that did not pass: Playwright trace for debugging, `npx playwright show-trace runs/<run>/trace.zip` |
| `llm/turn-NNN.request.json`, `.response.json` | Only with `LOG_REQUESTS=true`: the exact request sent to the model on each turn and its raw response |

`LOG_REQUESTS=true` in `.env` is for debugging what the model saw and decided. The files hold `{{env.NAME}}` placeholders, never secret values. They are large, because every request repeats the system prompt, tool definitions and conversation so far. The `encrypted_content` reasoning blobs cannot be read. The web UI does not serve these files, so open them from the run folder.

## Web UI

```sh
npm run ui                 # then open http://127.0.0.1:4300
npm run ui -- --port 5000
npm run dev                # same, but restarts by itself when a file in src/ changes
```

With `npm run dev` you don't need to restart after code changes. Saving a file in `src/` while a test is running stops that run, because the server restarts; the UI marks it as stopped. Edits to `ui/` need only a browser refresh (F5). Tasks, `.env` and `qa-genie.config.json` are read fresh for every run in either mode.

Lists the tasks in `tasks/`, lets you edit and save them, run them, and watch each step and screenshot as it happens. Past runs are listed under each task; to delete runs, click the bin in the Run history popover, then the ✕ on a run, which deletes its folder in `runs/` for good (a run still going can't be deleted). Drag tasks, or variables in the Variables list, to change their order; it is saved in `qa-genie.config.json` (`taskOrder`, and the order of `vars`), and new tasks go at the end. While editing a task, its name in the Tasks list becomes editable and is renamed when you save (its place in the list and its run history move with it), and the bin moves it to `tasks/.deleted` (recoverable from there; its past runs are kept). To delete variables, click the bin next to + New, then the ✕ on a variable; if tasks use it, the confirmation names them. In the editor, placeholders show as chips with just their name: `{{vars.NAME}}` in blue, `{{env.NAME}}` in blue with a dashed edge, and a `{{vars.NAME}}` with no such variable in red, since that task would fail. The task file still holds the full placeholder, and copying text copies it too. While editing, **+ Variable** lists your sign-in email (`{{env.LOGIN_EMAIL}}`, always first) and then the variables (type to filter, arrow keys and Enter to pick), and inserts the chosen one at the cursor; Backspace removes a chip whole, and typing a placeholder in full turns it into a chip. When not editing, hover a chip to see its value, and click it to show the variable (or Settings for `{{env.NAME}}`, or to add a missing variable). Different tasks can run at the same time, each in its own browser window, up to `MAX_PARALLEL_RUNS` (default 3, since each run uses roughly 50,000-130,000 model tokens a minute); a task already running can't be started again until it finishes. `.env` and `qa-genie.config.json` are re-read before every run.

The browser opens in a window on the machine running the server, so a person can sign in when a task says "let the user sign in". Fields filled from `.env` show as dots. `HEADLESS=true` in `.env` runs without a window.

Settings (the cog button at the top left) set the API key and the values tasks use as `{{env.NAME}}`. The model endpoint and deployment are only shown there while missing; otherwise change them in `.env`. Saving checks the model answers first, then writes them to `.env`. Keys and values are never sent back to the page. The dialog opens by itself when no endpoint, model or key is set. Clicking the QA Genie title opens a short description of what the app does.

Without `--port`, the UI takes the first free port from 4300. If QA Genie is already running from the same folder, it reuses that one. `--open` opens it in the browser.

The UI has no login. It listens on localhost only and refuses requests from other websites; don't expose it on a network, because anyone who can reach it can run tasks with your secrets.

## Sharing with people who don't use a terminal

```sh
npm run package            # on Windows; builds dist/QA-Genie.zip (about 60 MB)
```

The zip holds the app, this machine's `node.exe`, production dependencies and `Start QA Genie.cmd`. People unzip it and double-click the launcher, which keeps their settings, tasks and results in a `data` folder next to it (so everything stays in the one `QA Genie` folder) and opens the UI. On first start, Settings asks for the API key.

- Never includes the API key or secrets. The endpoint and model from your `.env` become the starter settings, and `tasks/` and `qa-genie.config.json` the starter tasks and variables, copied into `data` only when it has none yet. To keep their work when updating, people copy their `data` folder into the new version.
- Uses the installed Google Chrome (`BROWSER_CHANNEL=chrome`), and has traces and request logs off.
- Windows may warn about the launcher the first time ("More info", then "Run anyway"). Try a build on a colleague's laptop before sharing widely.

## Writing tests

Plain Markdown: steps and expected results. See [tasks/login.md](tasks/login.md).

- Be explicit about what to check. The model only passes a test when it observes every expected result.
- When a later step needs a value from an earlier page (an ID, a product code), just say so, e.g. "save the Product Code" and later "enter the saved Product Code". The model stores it with its `remember` tool, which keeps it available after old page snapshots are dropped. Saved values are listed in the report and the web UI.
- Put shared, non-secret values (site URLs, test data) in `qa-genie.config.json` and reference them as `{{vars.NAME}}`. They are filled into the task before the model reads it, so the model, reports and logs show the real value. An undefined name stops the run before the browser opens. The file is read before every run; add, edit, reorder and delete variables from Variables in the web UI, and insert one into a task with **+ Variable** while editing it.
  ```json
  { "vars": { "TEST_SITE": "https://test.example.com/", "SELLER_NAME": "Acme" } }
  ```
- Put secrets in `.env` and reference them as `{{env.NAME}}`. The model only ever sees the placeholder. The real value is filled in by the tool, removed from snapshots and logs, and the field is masked in screenshots. Only placeholders written in the task file can be used, and `.env` values take precedence over OS variables of the same name (such as `USERNAME` on Windows).

## Offline smoke test

```sh
npm run smoke              # headless
npm run smoke -- --headed
```

Runs the whole pipeline against a fake model and a local page, and checks that evidence is written and secrets do not leak. No Azure needed.

## How it works

```
task.md -> agent loop (src/agent.ts) <-> Foundry model (chat completions + tools)
                |
                v
        BrowserSession (src/browser.ts) -> Playwright, headed Chromium
                |
                v
        RunArtifacts (src/artifacts.ts) -> runs/<run>/
```

- The model sees the page as an accessibility snapshot with element refs (`button "Login" [ref=e12]`) and acts with `navigate`, `click`, `type`, `hover`, `scroll`, `select_option`, `press_key`, `wait_for`, `remember`, and `finish`.
- Only the latest snapshot is kept in the conversation, so long tests do not blow up the context.
- Tool errors are returned to the model so it can recover; `finish` is the only way a test passes or fails.
- Each step records a durable locator (e.g. `getByRole('button', { name: 'Login' })`) as groundwork for replaying passing runs without the LLM.

## Running elsewhere later

- `BROWSER_WS_ENDPOINT` connects to a remote browser instead of launching one.
- `HEADLESS=true` for CI; Entra ID auth picks up managed identity or a service principal.
- All output goes through `RunArtifacts`, the one place to change to upload to blob storage.

## Known limits (v0)

- Traces are off by default. With `TRACE=true`, `trace.zip` contains raw page data, including values typed from `.env`, so treat it like the `.env`. It is deleted when a run passes.
- Whatever is typed into a password, email or username field, by the tool or by a person signing in by hand, is shown to the model as `<hidden>`. An email address typed into one is also hidden wherever it appears later in the run (page text, title, URL). Other fields and other text are not hidden, and screenshots show email and username fields as they are.
- Screenshots mask fields that secrets were typed into, not secret values the app later displays as text.
- One test per run; no suites yet. The web UI runs different tasks in parallel (`MAX_PARALLEL_RUNS`), the CLI one task per command.
